import type { Message, ModelResponse } from "../model/types.js";

/**
 * One line of a session file (F24). The file is the full record of a session:
 * resume (F25) rebuilds the conversation from it, and replay (F26) plays it back.
 */

/** Settings that change what the loop does. Replay uses the same values. */
export interface RunLimits {
  maxSteps: number;
  tokenBudget: number;
  contextWindow: number;
}

interface Base {
  /** ISO time of the write. */
  t: string;
}

export interface StartRecord extends Base {
  type: "start" | "resume";
  sessionId: string;
  root: string;
  version: string;
  model: string;
  executor: string;
  isolation: string;
  limits: RunLimits;
}

export interface UserRecord extends Base {
  type: "user";
  message: Message;
}

export interface AssistantRecord extends Base {
  type: "assistant";
  step: number;
  response: ModelResponse;
  costUsd?: number;
}

export interface ToolCallMeta {
  toolUseId: string;
  name: string;
  durationMs: number;
  /** For tools that run commands: the executor and its isolation (N8). */
  executor?: string;
  isolation?: string;
}

export interface ToolResultsRecord extends Base {
  type: "tool_results";
  message: Message;
  calls: ToolCallMeta[];
  /** True for results that Garuda added for calls that never finished (a crash or Ctrl-C). */
  synthetic?: boolean;
}

export interface CompactionRecord extends Base {
  type: "compaction";
  stage: "trim" | "summary";
  beforeTokens: number;
  afterTokens: number;
  /** The whole conversation after compaction. */
  messages: Message[];
  /** stage "summary": the model response that holds the summary. */
  summary?: ModelResponse;
  costUsd?: number;
}

export interface EndRecord extends Base {
  type: "end";
  stopReason: string;
  steps: number;
}

export type SessionRecord =
  | StartRecord
  | UserRecord
  | AssistantRecord
  | ToolResultsRecord
  | CompactionRecord
  | EndRecord;

/** A record before the journal adds the time. */
export type NewRecord = SessionRecord extends infer R
  ? R extends SessionRecord
    ? Omit<R, "t">
    : never
  : never;
