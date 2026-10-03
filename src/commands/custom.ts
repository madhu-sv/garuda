import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { cleanText, neutralizeTags } from "../mcp/sanitize.js";
import type { ApprovalRequest } from "../permissions/types.js";

/**
 * Custom slash commands (0.4): Markdown files that become a prompt.
 *
 *   ~/.garuda/commands/<name>.md     user commands (trusted)
 *   <root>/.garuda/commands/<name>.md project commands (a cloned repo may add them)
 *
 * A file in a subfolder gets a name with ":" (frontend/test.md → /frontend:test). The body is
 * the prompt; `$ARGUMENTS` takes all arguments and `$1` … `$9` take one each. Optional
 * frontmatter gives a `description` and an `argument-hint` for /help.
 *
 * A command is only text: it becomes the user's prompt, and every tool call still passes the
 * permission engine and the sandbox. Project commands show their full text and ask once; the
 * answer is pinned to a hash of the file (like project hooks), so a changed file asks again.
 * Project command files may not be symbolic links (a link could show a secret file as a
 * command), and their text loses escape codes and invisible characters (they could hide lines
 * in the consent preview) and Garuda's own markers.
 */

export const COMMANDS_DIR = join(".garuda", "commands");
/** Larger files are refused: a command is a prompt, not a document. */
export const COMMAND_MAX_CHARS = 20_000;
const MAX_FILES = 200;
const NAME = /^[a-z0-9][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)*$/;

export interface CustomCommand {
  name: string;
  source: "user" | "project";
  file: string;
  description?: string;
  argumentHint?: string;
  /** The prompt text, after the frontmatter. */
  body: string;
  /** SHA-256 of the whole file, for the trust store. */
  hash: string;
}

export interface LoadedCommands {
  commands: CustomCommand[];
  /** Files that were skipped, and why. */
  problems: string[];
}

/**
 * Load user and project commands. A name that a built-in command uses is skipped. When a user
 * and a project command have the same name, the user command wins: the project cannot replace a
 * command that the user trusts.
 */
export async function loadCommands(options: {
  home: string;
  root: string;
  builtins: readonly string[];
}): Promise<LoadedCommands> {
  const problems: string[] = [];
  const user = await loadDir(join(options.home, COMMANDS_DIR), "user", problems);
  const project =
    join(options.home, COMMANDS_DIR) === join(options.root, COMMANDS_DIR)
      ? []
      : await loadDir(join(options.root, COMMANDS_DIR), "project", problems);
  const byName = new Map<string, CustomCommand>();
  for (const command of [...user, ...project]) {
    if (options.builtins.includes(command.name)) {
      problems.push(
        `${command.file}: /${command.name} is a built-in command; this file is ignored.`,
      );
      continue;
    }
    const existing = byName.get(command.name);
    if (existing !== undefined) {
      problems.push(
        `${command.file}: /${command.name} is also a user command (${existing.file}); the user command wins.`,
      );
      continue;
    }
    byName.set(command.name, command);
  }
  const commands = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { commands, problems };
}

async function loadDir(
  dir: string,
  source: CustomCommand["source"],
  problems: string[],
): Promise<CustomCommand[]> {
  let files: string[];
  try {
    files = (await readdir(dir, { recursive: true }))
      .filter((f) => f.endsWith(".md"))
      .sort()
      .slice(0, MAX_FILES);
  } catch {
    return [];
  }
  const out: CustomCommand[] = [];
  for (const rel of files) {
    const file = join(dir, rel);
    const name = relative(dir, file).slice(0, -3).split(sep).join(":").toLowerCase();
    if (!NAME.test(name)) {
      problems.push(`${file}: a command name may hold only a–z, 0–9, "-" and "_".`);
      continue;
    }
    try {
      if (source === "project" && (await lstat(file)).isSymbolicLink()) {
        problems.push(`${file}: a project command may not be a symbolic link; ignored.`);
        continue;
      }
      if (!(await stat(file)).isFile()) continue;
      const text = await readFile(file, "utf8");
      if (text.length > COMMAND_MAX_CHARS) {
        problems.push(`${file}: longer than ${COMMAND_MAX_CHARS} characters; ignored.`);
        continue;
      }
      const { meta, body: raw } = parseFrontmatter(text);
      const clean = cleanText(raw);
      const body = source === "project" ? neutralizeTags(clean) : clean;
      if (body.trim() === "") {
        problems.push(`${file}: the command has no text; ignored.`);
        continue;
      }
      const description = meta.description === undefined ? undefined : cleanText(meta.description);
      const hint =
        meta["argument-hint"] === undefined ? undefined : cleanText(meta["argument-hint"]);
      out.push({
        name,
        source,
        file,
        ...(description === undefined ? {} : { description }),
        ...(hint === undefined ? {} : { argumentHint: hint }),
        body: body.trim(),
        hash: createHash("sha256").update(text).digest("hex"),
      });
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}`);
    }
  }
  return out;
}

/**
 * A small frontmatter reader: `key: value` lines between two `---` lines. Only plain values; no
 * YAML library is needed for two optional keys.
 */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match === null) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv?.[1] !== undefined) meta[kv[1].toLowerCase()] = unquote((kv[2] ?? "").trim());
  }
  return { meta, body: text.slice(match[0].length) };
}

function unquote(value: string): string {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

/** Split `/name rest of line` into the name and the arguments. */
export function parseCommandLine(line: string): { name: string; args: string } | undefined {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(line.trim());
  if (match?.[1] === undefined) return undefined;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

/**
 * The prompt for a command. `$ARGUMENTS` gets all arguments, `$1` … `$9` one each (quotes group
 * words). With no placeholder in the text, the arguments go after it.
 */
export function expandCommand(command: CustomCommand, args: string): string {
  const words = splitArgs(args);
  const hasPlaceholder = /\$ARGUMENTS|\$[1-9]/.test(command.body);
  // One pass (0.14.1, review): "$5" or "$&" in the arguments stays as typed.
  const text = command.body.replace(/\$ARGUMENTS|\$([1-9])/g, (all, n?: string) =>
    all === "$ARGUMENTS" ? args : (words[Number(n) - 1] ?? ""),
  );
  return hasPlaceholder || args === "" ? text : `${text}\n\nArguments: ${args}`;
}

function splitArgs(args: string): string[] {
  const words: string[] = [];
  for (const match of args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return words;
}

/** The consent question for a project command, with its full text. */
export function commandConsent(
  command: CustomCommand,
  changed: boolean,
  isolation: string,
): ApprovalRequest {
  const lines = [
    changed
      ? `The project command /${command.name} changed since you allowed it (${command.file}).`
      : `/${command.name} is a project command from ${command.file}.`,
    "It sends this text to the model as your prompt:",
    "",
    ...command.body.split("\n").map((line) => `  │ ${line}`),
    "",
    "Tool calls that it leads to still ask or run in the sandbox, as usual.",
    "Run it only if you trust this project.",
  ];
  return {
    tool: "command",
    target: { kind: "input", json: JSON.stringify({ command: command.name, file: command.file }) },
    preview: lines.join("\n"),
    isolation: isolation as ApprovalRequest["isolation"],
    title: `Run the project command /${command.name}?`,
    labels: {
      once: "Yes, for this session only",
      session: "Yes, and remember (asks again if the file changes)",
      deny: "No",
    },
  };
}
