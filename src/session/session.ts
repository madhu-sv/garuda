import { contextSize } from "../model/pricing.js";
import type { ThinkingChoice } from "../model/thinking.js";
import {
  addUsage,
  type Message,
  type ModelResponse,
  type ToolResultBlock,
  type Usage,
  ZERO_USAGE,
} from "../model/types.js";
import { FileTracker } from "./fileTracker.js";
import type { ToolCallMeta } from "./records.js";
import { type Journal, newSessionId } from "./store.js";
import {
  emptyUndoState,
  newUserMessage,
  popPoint,
  pushPoint,
  type RedoEntry,
  redoPoint,
  type UndoPoint,
  type UndoState,
} from "./undo.js";

/**
 * Session state. Every change to the conversation goes through the functions below,
 * so the journal (F24) always matches the messages in memory.
 */
export interface Session {
  id: string;
  /** Absolute path of the working root. */
  root: string;
  messages: Message[];
  /** Token use for the whole session, including earlier runs and resumes. */
  usage: Usage;
  /** Cost for the whole session. Undefined when the model price is unknown. */
  costUsd: number | undefined;
  /** Context size after the last response, in tokens. Compaction (F23) reads it. */
  contextTokens: number;
  /** What the agent has read, for the edit_file freshness check (F11). */
  files: FileTracker;
  /** Where records go. Absent in tests that do not need a record. */
  journal?: Journal;
  /** Turns that /undo can take back, and undos that /redo can bring back (0.4). */
  undo: UndoState;
  /** The last /thinking choice of this session (0.9), from its records on resume. */
  thinking?: ThinkingChoice;
}

export function createSession(
  root: string,
  id: string = newSessionId(),
  journal?: Journal,
): Session {
  const session: Session = {
    id,
    root,
    messages: [],
    usage: { ...ZERO_USAGE },
    costUsd: 0,
    contextTokens: 0,
    files: new FileTracker(),
    undo: emptyUndoState(),
  };
  if (journal !== undefined) session.journal = journal;
  return session;
}

/**
 * Add the user's prompt. `notes` become extra text blocks after it: notes from Garuda
 * (in <garuda_note>), for example about MCP servers that are not available.
 */
export function addUserMessage(
  session: Session,
  text: string,
  notes: string[] = [],
  /** Text blocks the user attached, for example @files (0.6). */
  attachments: string[] = [],
): void {
  const message: Message = {
    role: "user",
    content: [
      { type: "text", text },
      ...attachments.map((a) => ({ type: "text" as const, text: a })),
      ...notes.map((note) => ({
        type: "text" as const,
        text: `<garuda_note>${note}</garuda_note>`,
      })),
    ],
  };
  session.messages.push(message);
  newUserMessage(session.undo);
  session.journal?.write({ type: "user", message });
}

/** Before a turn (0.4): record the snapshot of the files as an undo point. */
export function addSnapshot(
  session: Session,
  tree: string,
  prompt: string,
  durationMs: number,
): void {
  const messages = session.messages.length;
  pushPoint(session.undo, tree, messages, prompt);
  const point = session.undo.points.at(-1) as UndoPoint;
  session.journal?.write({ type: "snapshot", tree, messages, prompt: point.prompt, durationMs });
}

/** /undo (0.4): take the last turn out of the conversation. The caller restores the files. */
export function undoTurn(session: Session, after: string): UndoPoint | undefined {
  const point = popPoint(session.undo, session.messages, after);
  if (point !== undefined) session.journal?.write({ type: "undo", after });
  return point;
}

/** /redo (0.4): bring the last undone turn back. The caller restores the files. */
export function redoTurn(session: Session): RedoEntry | undefined {
  const entry = redoPoint(session.undo, session.messages);
  if (entry !== undefined) session.journal?.write({ type: "redo" });
  return entry;
}

export function addAssistantResponse(
  session: Session,
  response: ModelResponse,
  step: number,
  costUsd: number | undefined,
): void {
  addCost(session, response.usage, costUsd);
  session.contextTokens = contextSize(response.usage);
  if (response.content.length > 0) {
    session.messages.push({ role: "assistant", content: response.content });
  }
  session.journal?.write({
    type: "assistant",
    step,
    response,
    ...(costUsd === undefined ? {} : { costUsd }),
  });
}

export function addToolResults(
  session: Session,
  results: ToolResultBlock[],
  calls: ToolCallMeta[],
  synthetic = false,
): void {
  const message: Message = { role: "user", content: results };
  session.messages.push(message);
  session.journal?.write({
    type: "tool_results",
    message,
    calls,
    ...(synthetic ? { synthetic } : {}),
  });
}

/** Output limit (0.12): ask the model to go on after a cut-off response. */
export function addContinuation(session: Session, text: string, maxTokens: number): void {
  const message: Message = { role: "user", content: [{ type: "text", text }] };
  session.messages.push(message);
  session.journal?.write({ type: "continue", message, maxTokens });
}

/** Add token use and cost that are not part of a conversation turn (a compaction summary). */
export function addCost(session: Session, usage: Usage, costUsd: number | undefined): void {
  session.usage = addUsage(session.usage, usage);
  session.costUsd =
    session.costUsd === undefined || costUsd === undefined ? undefined : session.costUsd + costUsd;
}

/**
 * A run can stop between a tool call and its result (Ctrl-C, a crash).
 * The API refuses a tool_use with no tool_result, so add an error result for each open call.
 */
export function closeOpenToolCalls(session: Session): number {
  const last = session.messages.at(-1);
  if (last?.role !== "assistant") return 0;
  const open = last.content.filter((b) => b.type === "tool_use");
  if (open.length === 0) return 0;
  addToolResults(
    session,
    open.map((call) => ({
      type: "tool_result",
      toolUseId: call.id,
      content:
        "Error: this call was interrupted. It may or may not have run. Check before you retry.",
      isError: true,
    })),
    open.map((call) => ({ toolUseId: call.id, name: call.name, durationMs: 0 })),
    true,
  );
  return open.length;
}
