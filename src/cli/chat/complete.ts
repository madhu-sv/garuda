import { type Dirent, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * Tab completion in the chat (0.6): `/` commands (built-in, custom, skills) at the start of the
 * line, and `@` paths anywhere; since 0.8 also the arguments of a command (`args`). One match
 * completes; several complete their common start and list the candidates. Pure except for the
 * folder listing, which stays inside the root.
 */

export interface Completion {
  /** The new text and cursor. */
  text: string;
  cursor: number;
  /** Shown to the user when there is more than one match. */
  candidates: string[];
  /** The candidates have hints (0.8: a session's title): show one per line. */
  lines?: boolean;
}

/** One argument choice (0.8): the word to insert, and an optional hint to show with it. */
export interface ArgChoice {
  value: string;
  hint?: string;
}

export interface CompletionSources {
  /** Command names without "/", for example "help", "review", "git:commit". */
  commands: readonly string[];
  /** Entries of a folder in the root: names, folders end with "/". Hidden entries only on a "." prefix. */
  list(folder: string, withHidden: boolean): string[];
  /**
   * The choices for the next argument of `/command` (0.8). `before` has the arguments already
   * typed. Absent or empty: no completion.
   */
  args?(command: string, before: readonly string[]): readonly ArgChoice[];
  /** All files in the root, as relative paths (0.8): the fuzzy search when `@path` has no match. */
  files?(): readonly string[];
}

const MAX_CANDIDATES = 30;

export function complete(
  text: string,
  cursor: number,
  sources: CompletionSources,
): Completion | undefined {
  const before = text.slice(0, cursor);
  const start = before.search(/\S*$/);
  const word = before.slice(start);
  if (word.startsWith("/") && start === 0) {
    return apply(text, cursor, start, "/", word.slice(1), sources.commands, " ");
  }
  if (word.startsWith("@")) {
    const path = word.slice(1);
    const cut = path.lastIndexOf("/") + 1;
    const folder = path.slice(0, cut);
    const prefix = path.slice(cut);
    const entries = sources.list(folder, prefix.startsWith("."));
    const exact = apply(text, cursor, start, `@${folder}`, prefix, entries, "");
    if (exact !== undefined || sources.files === undefined || path === "") return exact;
    // No path starts so (0.8): a fuzzy search over all files, for example @rntm → src/app/runtime.ts.
    const found = fuzzyFiles(path, sources.files(), MAX_FUZZY);
    if (found.length === 0) return undefined;
    if (found.length === 1) {
      const insert = `@${found[0]}`;
      return {
        text: text.slice(0, start) + insert + text.slice(cursor),
        cursor: start + insert.length,
        candidates: [],
      };
    }
    return { text, cursor, candidates: found.map((f) => `@${f}`), lines: true };
  }
  if (before.startsWith("/") && start > 0 && sources.args !== undefined) {
    const [head = "", ...rest] = before.slice(0, start).trim().split(/\s+/);
    const choices = sources.args(head.slice(1), rest);
    if (choices.length === 0) return undefined;
    const hints = new Map(choices.map((c) => [c.value, c.hint]));
    const result = apply(
      text,
      cursor,
      start,
      "",
      word,
      choices.map((c) => c.value),
      " ",
    );
    if (result === undefined || result.candidates.length === 0 || hints.size === 0) return result;
    if (![...hints.values()].some((h) => h !== undefined && h !== "")) return result;
    return {
      ...result,
      lines: true,
      candidates: result.candidates.map((c) => {
        const hint = hints.get(c);
        return hint === undefined || hint === "" ? c : `${c}  ${hint}`;
      }),
    };
  }
  return undefined;
}

function apply(
  text: string,
  cursor: number,
  start: number,
  lead: string,
  prefix: string,
  options: readonly string[],
  after: string,
): Completion | undefined {
  const matches = [...new Set(options.filter((o) => o.startsWith(prefix)))].sort();
  if (matches.length === 0) return undefined;
  const common = commonStart(matches);
  // One match: complete it, and add a space after a command (not after a folder "…/").
  const done = matches.length === 1 && !common.endsWith("/");
  const insert = `${lead}${common}${done ? after : ""}`;
  const next = text.slice(0, start) + insert + text.slice(cursor);
  return {
    text: next,
    cursor: start + insert.length,
    candidates:
      matches.length === 1
        ? []
        : [
            ...matches.slice(0, MAX_CANDIDATES).map((m) => `${lead}${m}`),
            ...(matches.length > MAX_CANDIDATES
              ? [`… ${matches.length - MAX_CANDIDATES} more`]
              : []),
          ],
  };
}

function commonStart(words: readonly string[]): string {
  let out = words[0] ?? "";
  for (const w of words) {
    let i = 0;
    while (i < out.length && i < w.length && out[i] === w[i]) i++;
    out = out.slice(0, i);
  }
  return out;
}

/** The folder lister for the chat: only inside the root, skips .git and node_modules. */
export function rootLister(root: string): CompletionSources["list"] {
  return (folder, withHidden) => {
    const dir = resolve(root, folder === "" ? "." : folder);
    if (dir !== root && !dir.startsWith(`${root}${sep}`)) return [];
    try {
      return readdirSync(dir)
        .filter((n) => n !== ".git" && n !== "node_modules" && (withHidden || !n.startsWith(".")))
        .slice(0, 2_000)
        .map((n) => {
          try {
            return statSync(join(dir, n)).isDirectory() ? `${n}/` : n;
          } catch {
            return n;
          }
        });
    } catch {
      return [];
    }
  };
}

/** Most fuzzy matches shown (0.8). */
const MAX_FUZZY = 10;

/**
 * Fuzzy file search (0.8): the files whose path holds the query's characters in order (case does not
 * matter), best first. Per character: 1, plus 5 in a run and 3 at a word start (after /, -, _, .),
 * minus the gap since the last character (at most 10). A query that fits in the file name gets 20,
 * and 8 more when it starts the name; longer names lose a little. Shorter paths win a tie.
 */
export function fuzzyFiles(query: string, files: readonly string[], max: number): string[] {
  const q = query.toLowerCase();
  const scored: { file: string; score: number }[] = [];
  for (const file of files) {
    const score = fuzzyScore(q, file);
    if (score !== undefined) scored.push({ file, score });
  }
  return scored
    .sort(
      (a, b) => b.score - a.score || a.file.length - b.file.length || (a.file < b.file ? -1 : 1),
    )
    .slice(0, max)
    .map((s) => s.file);
}

function fuzzyScore(query: string, file: string): number | undefined {
  const path = file.toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;
  // Try the file name first: a query that fits in it is the best kind of match.
  const inName = match(query, path, nameStart);
  if (inName !== undefined) {
    const startsName = path[nameStart] === query[0] ? 8 : 0;
    return inName.score + 20 + startsName - (path.length - nameStart) / 10;
  }
  return match(query, path, 0)?.score;
}

function match(query: string, path: string, from: number): { score: number } | undefined {
  let score = 0;
  let at = from;
  let last = -1;
  for (const ch of query) {
    const i = path.indexOf(ch, at);
    if (i === -1) return undefined;
    score += 1;
    if (last >= 0) score += i === last + 1 ? 5 : -Math.min(i - last - 1, 10);
    const prev = path[i - 1];
    if (i === 0 || prev === "/" || prev === "-" || prev === "_" || prev === ".") score += 3;
    last = i;
    at = i + 1;
  }
  return { score };
}

/** Folders the file walk skips (0.8): tools' output and caches, not the user's code. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".garuda",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
]);
const MAX_FILES = 20_000;
const FILES_TTL_MS = 10_000;

/**
 * All files in the root for the fuzzy search (0.8): no hidden entries, no symbolic links, no
 * SKIP_DIRS, at most 20,000 files. The list is kept for 10 seconds, so repeated Tabs do not walk
 * the tree again.
 */
export function rootFiles(root: string, now: () => number = Date.now): () => string[] {
  let cache: { at: number; files: string[] } | undefined;
  return () => {
    if (cache !== undefined && now() - cache.at < FILES_TTL_MS) return cache.files;
    const files: string[] = [];
    const walk = (dir: string) => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) return;
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(full);
        } else if (entry.isFile()) {
          files.push(relative(root, full).split(sep).join("/"));
        }
      }
    };
    walk(root);
    cache = { at: now(), files };
    return files;
  };
}
