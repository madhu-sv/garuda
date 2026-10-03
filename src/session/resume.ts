import { contextSize } from "../model/pricing.js";
import { hasServerBlocks, withoutServerBlocks } from "../model/serverTools.js";
import { type ThinkingChoice, withoutThinking } from "../model/thinking.js";
import type { Message } from "../model/types.js";
import { addUsage, ZERO_USAGE } from "../model/types.js";
import type { SessionRecord, StartRecord } from "./records.js";
import { REDACTED } from "./redact.js";
import { closeOpenToolCalls, createSession, type Session } from "./session.js";
import type { SessionStore } from "./store.js";
import {
  compacted,
  emptyUndoState,
  newUserMessage,
  popPoint,
  pushPoint,
  redoPoint,
  type UndoState,
} from "./undo.js";

export interface RebuiltState {
  messages: Message[];
  usage: typeof ZERO_USAGE;
  costUsd: number | undefined;
  contextTokens: number;
  /** The last start or resume record: model, root and limits in use. */
  start: StartRecord | undefined;
  /** Undo points and redo entries (0.4). */
  undo: UndoState;
  /** The last /thinking choice (0.9). */
  thinking?: ThinkingChoice;
}

/** Rebuild the conversation and the totals from session records (F25). */
export function rebuildState(records: readonly SessionRecord[]): RebuiltState {
  const state: RebuiltState = {
    messages: [],
    usage: { ...ZERO_USAGE },
    costUsd: 0,
    contextTokens: 0,
    start: undefined,
    undo: emptyUndoState(),
  };
  const addCost = (cost: number | undefined) => {
    state.costUsd =
      state.costUsd === undefined || cost === undefined ? undefined : state.costUsd + cost;
  };

  for (const record of records) {
    switch (record.type) {
      case "start":
      case "resume":
      case "model":
        state.start = record;
        break;
      case "user":
        state.messages.push(record.message);
        newUserMessage(state.undo);
        break;
      case "snapshot":
        pushPoint(state.undo, record.tree, record.messages, record.prompt);
        break;
      case "undo":
        popPoint(state.undo, state.messages, record.after);
        break;
      case "redo":
        redoPoint(state.undo, state.messages);
        break;
      case "continue":
        state.messages.push(record.message);
        break;
      case "tool_results":
        state.messages.push(record.message);
        // Subagent runs (explore) count toward the session totals.
        for (const call of record.calls) {
          if (call.subagent === undefined) continue;
          state.usage = addUsage(state.usage, call.subagent.usage);
          addCost(call.subagent.costUsd);
        }
        break;
      case "assistant":
        state.usage = addUsage(state.usage, record.response.usage);
        addCost(record.costUsd);
        state.contextTokens = contextSize(record.response.usage);
        if (record.response.content.length > 0) {
          state.messages.push({ role: "assistant", content: record.response.content });
        }
        break;
      case "compaction":
        state.messages = structuredClone(record.messages);
        compacted(state.undo);
        state.contextTokens = record.afterTokens;
        if (record.summary !== undefined) {
          state.usage = addUsage(state.usage, record.summary.usage);
          addCost(record.costUsd);
        }
        break;
      case "thinking":
        state.thinking = record.choice;
        break;
      case "end":
      case "title":
        break;
    }
  }
  return state;
}

export interface ResumeOptions {
  store: SessionStore;
  root: string;
  /** Resume this session. Default: the latest one. */
  sessionId?: string;
  /** Written as the first new record. */
  start: Omit<StartRecord, "t" | "type" | "sessionId">;
}

/**
 * Load a session and continue it (F25). New records go to the same file.
 * The read tracking starts empty: the agent must read a file again before it edits it.
 */
export async function resumeSession(options: ResumeOptions): Promise<Session> {
  const id = options.sessionId ?? (await options.store.latest());
  if (id === undefined) throw new Error("There is no session to resume in this project.");
  const records = await options.store.read(id);
  const state = rebuildState(records);
  if (state.start !== undefined && state.start.root !== options.root) {
    throw new Error(`Session ${id} belongs to ${state.start.root}, not to ${options.root}.`);
  }

  const journal = options.store.open(id);
  const session = createSession(options.root, id, journal);
  const messages = dropThinkingAfterRedaction(
    state.messages.map(repairServerBlocks).map(repairThinking),
  );
  // Another model than the session's last one (0.9): thinking signatures do not carry over.
  session.messages =
    state.start !== undefined && state.start.model !== options.start.model
      ? withoutThinking(messages)
      : messages;
  session.usage = state.usage;
  session.costUsd = state.costUsd;
  session.contextTokens = state.contextTokens;
  session.undo = state.undo;
  if (state.thinking !== undefined) session.thinking = state.thinking;
  journal.write({ type: "resume", sessionId: id, ...options.start });
  closeOpenToolCalls(session);
  return session;
}

/**
 * Server search blocks must go back to the API unchanged (0.6). When redaction changed one on disk
 * (a secret in a query or a cited text), the API would refuse it: such a message keeps the titles
 * and URLs as plain text instead.
 */
/**
 * The API binds a thinking signature to all content before the block. When redaction changed a
 * message on disk, every thinking block after it fails ("bound to a different conversation"; live,
 * a Fable review that read source code with `tokenBudget: …` in it). So thinking blocks from the
 * first changed message on are left out; the ones before it still go back unchanged.
 */
export function dropThinkingAfterRedaction(messages: readonly Message[]): Message[] {
  const first = messages.findIndex((m) => JSON.stringify(m.content).includes(REDACTED));
  if (first < 0) return [...messages];
  return [...messages.slice(0, first), ...withoutThinking(messages.slice(first))];
}

/** A thinking block that redaction changed on disk cannot go back (0.9): it is left out. */
function repairThinking(message: Message): Message {
  if (message.role !== "assistant") return message;
  const broken = message.content.some(
    (b) => b.type === "thinking" && JSON.stringify(b.wire).includes(REDACTED),
  );
  if (!broken) return message;
  return {
    ...message,
    content: message.content.filter(
      (b) => b.type !== "thinking" || !JSON.stringify(b.wire).includes(REDACTED),
    ),
  };
}

function repairServerBlocks(message: Message): Message {
  if (message.role !== "assistant" || !hasServerBlocks(message.content)) return message;
  if (!JSON.stringify(message.content).includes(REDACTED)) return message;
  return { ...message, content: withoutServerBlocks(message.content) };
}
