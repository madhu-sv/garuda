import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { z } from "zod";
import { displayPath, isInside, resolveInRoot } from "../permissions/pathGuard.js";
import { isSensitive } from "../permissions/sensitive.js";
import type { PermissionGate } from "../permissions/types.js";
import { isDirectory, listFiles } from "./files.js";
import { cutLine, joinWithinLimit, LIMITS, looksBinary, splitLines } from "./limits.js";
import { RegexMatcher } from "./regexWorker.js";
import type { Tool } from "./types.js";

/**
 * grep (F13): search file contents with a JavaScript regular expression.
 * It is written in TypeScript, not with ripgrep, so the single `garuda` binary
 * needs no second native binary. It respects .gitignore and skips binary and large files.
 */

const input = z.object({
  pattern: z
    .string()
    .min(1)
    .describe("JavaScript regular expression, for example 'function\\s+main'."),
  path: z
    .string()
    .optional()
    .describe("File or folder to search, relative to the working root. Default: the working root."),
  glob: z
    .string()
    .optional()
    .describe('Only search files that match this glob, for example "**/*.ts".'),
  ignoreCase: z.boolean().optional().describe("Case-insensitive search. Default: false."),
  mode: z
    .enum(["files", "content", "count"])
    .optional()
    .describe(
      "files: paths with a match (default). content: matching lines as path:line:text. count: matches per file.",
    ),
  context: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe("content mode only: lines of context before and after each match. Default: 0."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.grepResultsMax)
    .optional()
    .describe(`Maximum results (files, lines or counts). Default: ${LIMITS.grepResults}.`),
});

type Input = z.infer<typeof input>;

export interface GrepOutput {
  mode: "files" | "content" | "count";
  lines: string[];
  /** Results found before the limit stopped the search. */
  truncated: boolean;
  filesSearched: number;
}

export const grepTool: Tool<Input, GrepOutput> = {
  name: "grep",
  description: [
    "Search file contents in the working root with a JavaScript regular expression.",
    "Respects .gitignore. Skips binary files, sensitive files (.env, keys) and files over 1 MB.",
    'Modes: "files" lists matching paths, "content" shows path:line:text, "count" shows matches per file.',
  ].join("\n"),
  inputSchema: input,
  readOnly: true,

  async run(args, { root, signal, permissions }) {
    const mode = args.mode ?? "files";
    const max = args.maxResults ?? LIMITS.grepResults;
    const context = mode === "content" ? (args.context ?? 0) : 0;

    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, args.ignoreCase ? "i" : "");
    } catch (error) {
      throw new Error(`Invalid regular expression: ${(error as Error).message}`);
    }

    // The match runs in a worker, so a pattern that backtracks badly cannot block Garuda.
    const matcher = new RegexMatcher(regex.source, regex.flags, signal);
    try {
      return await search(args, root, signal, permissions, matcher, mode, max, context);
    } finally {
      matcher.close();
    }
  },

  toText({ lines, truncated, filesSearched }) {
    if (lines.length === 0) return `No matches in ${filesSearched} files.`;
    const { text, omitted } = joinWithinLimit(lines);
    const notes: string[] = [];
    if (truncated)
      notes.push(
        "Reached the result limit, so more matches may exist. Narrow the pattern, path or glob.",
      );
    if (omitted > 0) notes.push(`${omitted} more lines did not fit in the output.`);
    return notes.length === 0 ? text : `${text}\n\n[${notes.join(" ")}]`;
  },
};

async function search(
  args: Input,
  root: string,
  signal: AbortSignal,
  permissions: PermissionGate,
  matcher: RegexMatcher,
  mode: GrepOutput["mode"],
  max: number,
  context: number,
): Promise<GrepOutput> {
  const target = await resolveInRoot(root, args.path ?? ".");
  const files = (await isDirectory(target))
    ? await listFiles(target, args.glob ?? "**/*", root)
    : [target];
  files.sort();

  const out: string[] = [];
  let results = 0;
  let truncated = false;
  let searched = 0;
  let realRoot: string | undefined;

  for (const file of files) {
    signal.throwIfAborted();
    if (results >= max) {
      truncated = true;
      break;
    }
    // Sensitive files are never searched (F20). read_file with an allow rule can still read them.
    // Team policy denyPaths (G04): neither the content nor the name of such a file is shown.
    const shownPath = displayPath(root, file);
    if (isSensitive(shownPath) || permissions.deniedByPolicy(shownPath)) continue;
    // A symbolic link: the file it reaches must pass the same checks, and stay in the root.
    if ((await lstat(file).catch(() => undefined))?.isSymbolicLink() === true) {
      realRoot ??= await realpath(root);
      const real = await realpath(file).catch(() => undefined);
      if (real === undefined || !isInside(realRoot, real)) continue;
      const realShown = displayPath(realRoot, real);
      if (isSensitive(realShown) || permissions.deniedByPolicy(realShown)) continue;
    }
    const info = await stat(file).catch(() => undefined);
    if (info === undefined || !info.isFile() || info.size > LIMITS.grepFileBytes) continue;
    const buffer = await readFile(file);
    if (looksBinary(buffer)) continue;
    searched++;

    const lines = splitLines(buffer.toString("utf8"));
    const hits = await matcher.match(lines, shownPath);
    if (hits.length === 0) continue;

    const shown = shownPath;
    if (mode === "files") {
      out.push(shown);
      results++;
    } else if (mode === "count") {
      out.push(`${shown}:${hits.length}`);
      results++;
    } else {
      const room = max - results;
      if (hits.length > room) truncated = true;
      const used = hits.slice(0, room);
      out.push(...contentLines(shown, lines, used, context));
      results += used.length;
    }
  }

  return { mode, lines: out, truncated, filesSearched: searched };
}

/** path:line:text for matches, path-line-text for context, "--" between groups. */
function contentLines(path: string, lines: string[], hits: number[], context: number): string[] {
  const out: string[] = [];
  const hitSet = new Set(hits);
  let lastPrinted = -2;
  for (const hit of hits) {
    const from = Math.max(0, hit - context);
    const to = Math.min(lines.length - 1, hit + context);
    const start = Math.max(from, lastPrinted + 1);
    if (context > 0 && lastPrinted >= 0 && start > lastPrinted + 1) out.push("--");
    for (let i = start; i <= to; i++) {
      const sep = hitSet.has(i) ? ":" : "-";
      out.push(`${path}${sep}${i + 1}${sep}${cutLine(lines[i] ?? "", 500)}`);
    }
    lastPrinted = Math.max(lastPrinted, to);
  }
  return out;
}
