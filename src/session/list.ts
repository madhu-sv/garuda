import type { SessionRecord } from "./records.js";
import { rebuildState } from "./resume.js";

/** One row of /sessions (0.6). */
export interface SessionSummary {
  id: string;
  updated: Date;
  /** The first line of the first prompt, cut short. Empty for a session with no prompt. */
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
  const line = (first?.type === "text" ? first.text : "").trim().split("\n")[0] ?? "";
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
