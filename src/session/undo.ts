import type { Message } from "../model/types.js";

/**
 * The conversation side of undo (0.4). Before each turn, the runtime takes a snapshot of the files
 * (src/undo/) and records an undo point here: the snapshot's tree and the message count before the
 * turn. /undo pops the last point: the files go back to its tree, and the turn's messages move to
 * the redo stack. /redo brings both back.
 *
 * The same pure steps run live (session.ts) and when a session file is read again (resume, replay),
 * so both give the same conversation.
 */

export interface UndoPoint {
  /** The snapshot tree before the turn (a git tree id in the snapshot store). */
  tree: string;
  /** Messages before the turn. */
  messages: number;
  /** False after a compaction: the turn's messages are no longer separate, so only files go back. */
  conversation: boolean;
  /** The start of the turn's prompt, for the /undo question. */
  prompt: string;
}

export interface RedoEntry {
  point: UndoPoint;
  /** The snapshot tree of the files at the time of the undo. */
  after: string;
  /** The messages that the undo removed (none when `conversation` was false). */
  removed: Message[];
}

export interface UndoState {
  points: UndoPoint[];
  redo: RedoEntry[];
}

export const MAX_UNDO_POINTS = 50;
const PROMPT_CHARS = 80;

export function emptyUndoState(): UndoState {
  return { points: [], redo: [] };
}

/** A new turn: a new undo point. Redo is no longer possible. */
export function pushPoint(state: UndoState, tree: string, messages: number, prompt: string): void {
  const line = prompt.replace(/\s+/g, " ").trim();
  state.points.push({
    tree,
    messages,
    conversation: true,
    prompt: line.length > PROMPT_CHARS ? `${line.slice(0, PROMPT_CHARS)}…` : line,
  });
  if (state.points.length > MAX_UNDO_POINTS) state.points.shift();
  state.redo = [];
}

/** Undo the last turn in the conversation. Returns the point, or undefined when there is none. */
export function popPoint(
  state: UndoState,
  messages: Message[],
  after: string,
): UndoPoint | undefined {
  const point = state.points.pop();
  if (point === undefined) return undefined;
  const removed = point.conversation ? messages.splice(point.messages) : [];
  state.redo.push({ point, after, removed });
  return point;
}

/** Redo the last undo. Returns the entry, or undefined when there is none. */
export function redoPoint(state: UndoState, messages: Message[]): RedoEntry | undefined {
  const entry = state.redo.pop();
  if (entry === undefined) return undefined;
  messages.push(...entry.removed);
  state.points.push(entry.point);
  return entry;
}

/** A compaction replaced the messages: earlier turns can only undo their files. */
export function compacted(state: UndoState): void {
  for (const point of state.points) point.conversation = false;
  for (const entry of state.redo) {
    entry.point.conversation = false;
    entry.removed = [];
  }
}

/** A new user message (with or without a snapshot) ends the redo chain. */
export function newUserMessage(state: UndoState): void {
  state.redo = [];
}
