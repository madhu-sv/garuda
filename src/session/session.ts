import { randomUUID } from "node:crypto";
import { type Message, type Usage, ZERO_USAGE } from "../model/types.js";
import { FileTracker } from "./fileTracker.js";

/**
 * In-memory session state. M4 adds the JSONL store (F24) and resume (F25).
 */
export interface Session {
  id: string;
  /** Absolute path of the working root. */
  root: string;
  messages: Message[];
  usage: Usage;
  /** What the agent has read, for the edit_file freshness check (F11). */
  files: FileTracker;
}

export function createSession(root: string, id: string = randomUUID()): Session {
  return { id, root, messages: [], usage: { ...ZERO_USAGE }, files: new FileTracker() };
}

export function addUserMessage(session: Session, text: string): void {
  session.messages.push({ role: "user", content: [{ type: "text", text }] });
}
