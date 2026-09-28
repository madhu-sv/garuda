import { readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

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
    return apply(text, cursor, start, `@${folder}`, prefix, entries, "");
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
