import type { SessionRecord } from "./records.js";
import { rebuildState } from "./resume.js";

/** One row of /sessions (0.6). */
export interface SessionSummary {
  id: string;
  updated: Date;
  /**
   * The title from /sessions rename (0.8), else the first line of the first prompt, cut short.
   * Empty for a session with neither.
   */
  title: string;
  /** The number of prompts. */
  turns: number;
  /** The model of the last start, resume or /models record. */
  model: string | undefined;
  costUsd: number | undefined;
}

const TITLE_CHARS = 60;

export function summariseSession(
  id: string,
  updated: Date,
  records: readonly SessionRecord[],
): SessionSummary {
  const prompts = records.filter((r) => r.type === "user");
  const first = prompts[0]?.message.content.find((b) => b.type === "text");
  const named = records.findLast((r) => r.type === "title");
  const line =
    named?.type === "title"
      ? named.title
      : ((first?.type === "text" ? first.text : "").trim().split("\n")[0] ?? "");
  const state = rebuildState(records);
  return {
    id,
    updated,
    title: line.length <= TITLE_CHARS ? line : `${line.slice(0, TITLE_CHARS - 1)}…`,
    turns: prompts.length,
    model: state.start?.model,
    costUsd: state.costUsd,
  };
}

/** Most characters of a title (0.8). */
export const MAX_TITLE_CHARS = TITLE_CHARS;

/** A title as the user typed it, made safe for one line of /sessions: no control characters. */
export function cleanTitle(text: string): string {
  const one = [...text]
    .map((c) => {
      const code = c.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code < 160) ? " " : c;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return one.length <= MAX_TITLE_CHARS ? one : `${one.slice(0, MAX_TITLE_CHARS - 1)}…`;
}
