import type { Message, ModelResponse, Usage } from "../model/types.js";

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
  /** "model" (0.6): the user switched the model with /models; the next turns use it. */
  type: "start" | "resume" | "model";
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
  /** For a subagent call (explore): what the child run used. Resume adds it to the totals. */
  subagent?: SubagentReport;
}

/** What one subagent run used (0.3). Its own session file holds the details. */
export interface SubagentReport {
  /** The child session id; its file is .garuda/sessions/<parent id>/<child id>.jsonl. */
  sessionId: string;
  model: string;
  steps: number;
  stopReason: string;
  usage: Usage;
  costUsd?: number;
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

/** Before a turn (0.4): the snapshot of the files, and the message count before the turn. */
export interface SnapshotRecord extends Base {
  type: "snapshot";
  tree: string;
  messages: number;
  prompt: string;
  durationMs: number;
}

/** /undo (0.4): the last turn went back; `after` is the snapshot of the files before the undo. */
export interface UndoRecord extends Base {
  type: "undo";
  after: string;
}

/** /redo (0.4): the last undo went back. */
export interface RedoRecord extends Base {
  type: "redo";
}

/** /sessions rename (0.8): the session's title in /sessions. The last one wins. */
export interface TitleRecord extends Base {
  type: "title";
  title: string;
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
  | SnapshotRecord
  | UndoRecord
  | RedoRecord
  | TitleRecord
  | EndRecord;

/** A record before the journal adds the time. */
export type NewRecord = SessionRecord extends infer R
  ? R extends SessionRecord
    ? Omit<R, "t">
    : never
  : never;
