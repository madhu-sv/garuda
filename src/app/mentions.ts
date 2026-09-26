import { readdir, readFile, stat } from "node:fs/promises";
import { displayPath, PathOutsideRootError, resolveInRoot } from "../permissions/pathGuard.js";
import { isSensitive } from "../permissions/sensitive.js";
import type { FileTracker } from "../session/fileTracker.js";
import { cutLine, joinWithinLimit, LIMITS, looksBinary, splitLines } from "../tools/limits.js";

/**
 * `@path` in a prompt (0.6): the user attaches a file or a folder. A file's text goes with the
 * message, numbered like read_file (at most 2 000 lines), and counts as read, so the model can edit
 * it at once. A folder gives its list of entries. The same rules as read_file apply: only paths in
 * the root, no sensitive files, no binary files. A word after "@" that is not a path stays text
 * (an e-mail address, a decorator, @someone).
 */

export const MAX_ATTACHMENTS = 10;
const MAX_TOTAL_CHARS = 150_000;
const MAX_FOLDER_ENTRIES = 200;

export interface Attachment {
  /** As shown to the user and the model, relative to the root. */
  path: string;
  /** The text block that goes with the message. */
  text: string;
  /** One line for the user: "src/a.ts (42 lines)". */
  summary: string;
}

export interface MentionResult {
  attachments: Attachment[];
  /** Mentions that look like paths but were not attached, with the reason. */
  skipped: string[];
}

/** The `@word` tokens of a prompt: at the start or after white space; trailing punctuation dropped. */
export function mentionTokens(prompt: string): string[] {
  const out: string[] = [];
  for (const match of prompt.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const token = (match[1] ?? "").replace(/[),.;:!?'"\]]+$/, "");
    if (token !== "" && !out.includes(token)) out.push(token);
  }
  return out;
}

export async function attachMentions(
  prompt: string,
  root: string,
  files: FileTracker,
): Promise<MentionResult> {
  const attachments: Attachment[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const token of mentionTokens(prompt)) {
    let absolute: string;
    try {
      absolute = await resolveInRoot(root, token);
    } catch (error) {
      // "@/etc/passwd" or "@../x": a path, but outside the root.
      if (error instanceof PathOutsideRootError && /[/\\.]/.test(token)) {
        skipped.push(`@${token}: outside the working folder`);
      }
      continue;
    }
    const info = await stat(absolute).catch(() => undefined);
    if (info === undefined) continue; // not a path: leave the word as text
    const shown = displayPath(root, absolute);
    if (attachments.length >= MAX_ATTACHMENTS) {
      skipped.push(`@${shown}: more than ${MAX_ATTACHMENTS} attachments`);
      continue;
    }
    if (isSensitive(shown)) {
      skipped.push(`@${shown}: a sensitive file (read_file refuses it too)`);
      continue;
    }
    const attachment = info.isDirectory()
      ? await folder(absolute, shown)
      : await file(absolute, shown, info.size, files);
    if (typeof attachment === "string") {
      skipped.push(`@${shown}: ${attachment}`);
      continue;
    }
    if (total + attachment.text.length > MAX_TOTAL_CHARS) {
      skipped.push(`@${shown}: the attachments are already ${MAX_TOTAL_CHARS} characters`);
      continue;
    }
    total += attachment.text.length;
    attachments.push(attachment);
  }
  return { attachments, skipped };
}

async function file(
  absolute: string,
  shown: string,
  size: number,
  files: FileTracker,
): Promise<Attachment | string> {
  if (size > LIMITS.readFileBytes) return `larger than ${LIMITS.readFileBytes} bytes`;
  const buffer = await readFile(absolute);
  if (looksBinary(buffer)) return "a binary file";
  files.record(absolute, buffer);
  const lines = buffer.length === 0 ? [] : splitLines(buffer.toString("utf8"));
  const slice = lines.slice(0, LIMITS.readLines);
  const { text, omitted } = joinWithinLimit(
    slice.map((line, i) => `${String(i + 1).padStart(6)}\t${cutLine(line)}`),
  );
  const shownLines = slice.length - omitted;
  const more =
    shownLines < lines.length
      ? `\n[Lines 1–${shownLines} of ${lines.length}. Read the rest with read_file, offset ${shownLines + 1}.]`
      : "";
  return {
    path: shown,
    text: `The user attached ${shown}:\n${lines.length === 0 ? "(empty file)" : text}${more}`,
    summary: `${shown} (${shownLines < lines.length ? `${shownLines} of ` : ""}${lines.length} line${lines.length === 1 ? "" : "s"})`,
  };
}

async function folder(absolute: string, shown: string): Promise<Attachment | string> {
  const entries = await readdir(absolute, { withFileTypes: true });
  const names = entries
    .filter((e) => e.name !== ".git")
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  const listed = names.slice(0, MAX_FOLDER_ENTRIES);
  const more = names.length > listed.length ? `\n… ${names.length - listed.length} more` : "";
  const base = shown === "." ? "" : `${shown}/`;
  return {
    path: shown,
    text: `The user attached the folder ${shown}/ (its entries):\n${listed.map((n) => `${base}${n}`).join("\n")}${more}`,
    summary: `${shown}/ (${names.length} entr${names.length === 1 ? "y" : "ies"})`,
  };
}
