import type { Approver } from "../permissions/types.js";
import type { Isolation } from "../sandbox/types.js";
import { addSnapshot, redoTurn, type Session, undoTurn } from "../session/session.js";
import { filesText, undoQuestion } from "../undo/question.js";
import { SLOW_SNAPSHOT_MS, SnapshotError, type SnapshotStore } from "../undo/snapshots.js";

export { SnapshotError };

export class UndoCoordinator {
  private snapshots: SnapshotStore | undefined;

  constructor(
    snapshots: SnapshotStore | undefined,
    private readonly approver: Approver,
    private readonly isolation: Isolation,
    private readonly onNotice?: (text: string) => void,
  ) {
    this.snapshots = snapshots;
  }

  get enabled(): boolean {
    return this.snapshots !== undefined;
  }

  get store(): SnapshotStore | undefined {
    return this.snapshots;
  }

  /** Snapshot the files before a turn. A failure turns undo off with a notice; the turn goes on. */
  async snapshot(session: Session, prompt: string, signal: AbortSignal): Promise<void> {
    const store = this.snapshots;
    if (store === undefined) return;
    const started = Date.now();
    try {
      const tree = await store.take(signal);
      const ms = Date.now() - started;
      addSnapshot(session, tree, prompt, ms);
      if (ms > SLOW_SNAPSHOT_MS) {
        this.snapshots = undefined;
        this.onNotice?.(
          `The undo snapshot took ${(ms / 1000).toFixed(1)} s, so undo is off for this session. Add big folders to .gitignore, or set "undo": { "enabled": false } in .garuda/settings.json.`,
        );
      }
    } catch (error) {
      if (signal.aborted) throw error;
      this.snapshots = undefined;
      this.onNotice?.(`Undo is off for this session: ${(error as Error).message}`);
    }
  }

  async undo(
    session: Session | undefined,
    pendingNotes: string[],
    signal: AbortSignal,
  ): Promise<string> {
    return this.undoRedo("undo", session, pendingNotes, signal);
  }

  async redo(
    session: Session | undefined,
    pendingNotes: string[],
    signal: AbortSignal,
  ): Promise<string> {
    return this.undoRedo("redo", session, pendingNotes, signal);
  }

  private async undoRedo(
    kind: "undo" | "redo",
    session: Session | undefined,
    pendingNotes: string[],
    signal: AbortSignal,
  ): Promise<string> {
    try {
      return kind === "undo"
        ? await this.undoNow(session, pendingNotes, signal)
        : await this.redoNow(session, pendingNotes, signal);
    } catch (error) {
      if (!(error instanceof SnapshotError)) throw error;
      return `The ${kind} failed, and no file changed: ${error.message}`;
    }
  }

  private async undoNow(
    session: Session | undefined,
    pendingNotes: string[],
    signal: AbortSignal,
  ): Promise<string> {
    const store = this.snapshots;
    if (store === undefined) return "Undo is off for this session.";
    const point = session?.undo.points.at(-1);
    if (session === undefined || point === undefined) return "There is no turn to undo.";
    const now = await store.take(signal);
    const changes = await store.changes(now, point.tree, signal);
    const choice = await this.approver.ask(
      undoQuestion("undo", point.prompt, changes, point.conversation, this.isolation),
      signal,
    );
    if (choice === "deny") return "Nothing changed.";
    await store.restore(now, point.tree, signal);
    undoTurn(session, now);
    if (!point.conversation) {
      pendingNotes.push(
        `The user undid the turn "${point.prompt}": its file changes are gone. Read files again before you edit them.`,
      );
    }
    return `Undid "${point.prompt}": ${filesText(changes)}${point.conversation ? "; the conversation went back too" : ""}. /redo brings it back.`;
  }

  private async redoNow(
    session: Session | undefined,
    pendingNotes: string[],
    signal: AbortSignal,
  ): Promise<string> {
    const store = this.snapshots;
    if (store === undefined) return "Undo is off for this session.";
    const entry = session?.undo.redo.at(-1);
    if (session === undefined || entry === undefined) return "There is nothing to redo.";
    const now = await store.take(signal);
    const changes = await store.changes(now, entry.after, signal);
    const choice = await this.approver.ask(
      undoQuestion("redo", entry.point.prompt, changes, entry.removed.length > 0, this.isolation),
      signal,
    );
    if (choice === "deny") return "Nothing changed.";
    await store.restore(now, entry.after, signal);
    redoTurn(session);
    if (entry.removed.length === 0) {
      pendingNotes.push(
        `The user redid the turn "${entry.point.prompt}": its file changes are back. Read files again before you edit them.`,
      );
    }
    return `Redid "${entry.point.prompt}": ${filesText(changes)}.`;
  }
}
