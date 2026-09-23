import { contextSize } from "../model/pricing.js";
import { addUsage, type Message, ZERO_USAGE } from "../model/types.js";
import type { SessionRecord, StartRecord } from "./records.js";
import { closeOpenToolCalls, createSession, type Session } from "./session.js";
import type { SessionStore } from "./store.js";

export interface RebuiltState {
  messages: Message[];
  usage: typeof ZERO_USAGE;
  costUsd: number | undefined;
  contextTokens: number;
  /** The last start or resume record: model, root and limits in use. */
  start: StartRecord | undefined;
}

/** Rebuild the conversation and the totals from session records (F25). */
export function rebuildState(records: readonly SessionRecord[]): RebuiltState {
  const state: RebuiltState = {
    messages: [],
    usage: { ...ZERO_USAGE },
    costUsd: 0,
    contextTokens: 0,
    start: undefined,
  };
  const addCost = (cost: number | undefined) => {
    state.costUsd =
      state.costUsd === undefined || cost === undefined ? undefined : state.costUsd + cost;
  };

  for (const record of records) {
    switch (record.type) {
      case "start":
      case "resume":
        state.start = record;
        break;
      case "user":
      case "tool_results":
        state.messages.push(record.message);
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
        state.contextTokens = record.afterTokens;
        if (record.summary !== undefined) {
          state.usage = addUsage(state.usage, record.summary.usage);
          addCost(record.costUsd);
        }
        break;
      case "end":
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
  session.messages = state.messages;
  session.usage = state.usage;
  session.costUsd = state.costUsd;
  session.contextTokens = state.contextTokens;
  journal.write({ type: "resume", sessionId: id, ...options.start });
  closeOpenToolCalls(session);
  return session;
}
