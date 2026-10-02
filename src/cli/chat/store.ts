import type { AgentEvent } from "../../loop/runAgent.js";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../../permissions/types.js";
import { colorPreview, header } from "../approver.js";
import type { Renderer } from "../renderer.js";
import {
  retryText,
  serverToolOutput,
  serverToolText,
  summariseCall,
  summariseResult,
  todoLines,
} from "../renderer.js";
import type { Interruptible } from "../turn.js";
import {
  createHunkStaging,
  discardAllHunks,
  type HunkStagingState,
  navigateHunk,
  stageAllRemaining,
  stageCurrentHunk,
} from "./hunkStaging.js";
import { type EditAction, type EditorState, edit, emptyEditor, submit } from "./lineEditor.js";
import { ansi, type Paint, renderMarkdown, takeBlocks } from "./markdown.js";
import { filterPalette, type PaletteEntry, type PaletteState } from "./palette.js";

/**
 * The state of the Ink chat (0.2). The view only draws it; all logic is here, so tests
 * need no terminal. It is the renderer, the approver and the Ctrl-C target of a turn.
 *
 * Finished lines go to `items` (the view prints them once, into the scrollback).
 * The live part is small: the open text block, running tools, the approval choice,
 * the queue and the input line.
 */

export type Item =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "text"; text: string }
  | { id: number; kind: "tool"; text: string }
  | { id: number; kind: "note"; level: "info" | "warn" | "error"; text: string }
  | { id: number; kind: "output"; text: string };

/** An item before it has an id. */
type NewItem = Item extends infer I ? (I extends Item ? Omit<I, "id"> : never) : never;

export interface RunningTool {
  id: string;
  line: string;
}

export interface PendingApproval {
  request: ApprovalRequest;
  /** The choices (default three), with the request's own labels. */
  choices: { choice: ApprovalChoice; label: string }[];
  /** The highlighted choice. */
  selected: number;
  /** Active interactive hunk staging, if user entered hunk review mode (0.14). */
  hunkReview?: HunkStagingState | undefined;
}

export const APPROVAL_CHOICES: readonly { choice: ApprovalChoice; label: string }[] = [
  { choice: "once", label: "Yes, once" },
  { choice: "session", label: "Yes, for this session" },
  { choice: "deny", label: "No, deny" },
];

export interface Status {
  model: string;
  sandbox: string;
  /** Shown only in plan mode (0.4). */
  mode?: "plan";
  contextPercent?: number;
  costUsd?: number;
}

export interface ChatState {
  items: Item[];
  /** The open block of model text: plain until it ends. */
  streaming: string;
  running: RunningTool[];
  approval: PendingApproval | undefined;
  queue: string[];
  editor: EditorState;
  busy: boolean;
  status: Status;
  /** Set when a turn ends Garuda (Ctrl-D, /exit, two Ctrl-C). */
  exiting: boolean;
  /** The command palette, while it is open (0.9, Ctrl-P). */
  palette?: PaletteState;
}

const EXIT_WINDOW_MS = 2_000;

export class ChatStore implements Renderer, Approver, Interruptible {
  /** Set by runTurnInTerminal during a turn: it stops the turn. */
  onInterrupt: () => void = () => {};
  private state: ChatState;
  private readonly listeners = new Set<() => void>();
  private nextId = 0;
  private waiting: ((input: string | undefined) => void) | undefined;
  private answer: ((choice: ApprovalChoice) => void) | undefined;
  private lastOutput: { title: string; text: string } | undefined;
  /** All palette rows while the palette is open (0.9). */
  private paletteAll: PaletteEntry[] = [];
  private interruptAt = 0;
  /** A stop of the running turn was asked (Esc or Ctrl-C): Esc does not ask again. */
  private stopping = false;
  /** Tab (0.6): the chat sets it; see complete.ts. */
  completer:
    | ((
        text: string,
        cursor: number,
      ) => { text: string; cursor: number; candidates: string[]; lines?: boolean } | undefined)
    | undefined;
  /** The command palette's rows (0.9): the chat sets it. */
  paletteSource: (() => PaletteEntry[]) | undefined;
  /** Ctrl-G and /editor (0.6): the chat sets it; it edits the text in the user's editor. */
  externalEdit: ((text: string) => { text?: string; problem?: string }) | undefined;
  private readonly paint: Paint;
  private readonly now: () => number;

  constructor(
    status: Status,
    options: { paint?: Paint; now?: () => number; history?: string[] } = {},
  ) {
    this.paint = options.paint ?? ansi;
    this.now = options.now ?? Date.now;
    this.state = {
      items: [],
      streaming: "",
      running: [],
      approval: undefined,
      queue: [],
      editor: emptyEditor(options.history),
      busy: false,
      status,
      exiting: false,
    };
  }

  // The external store for React (useSyncExternalStore).
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): ChatState => this.state;

  private update(change: Partial<ChatState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  private add(item: NewItem): void {
    this.update({ items: [...this.state.items, { ...item, id: this.nextId++ } as Item] });
  }

  // Input.

  /** The next line to run: from the queue, or the next Enter. undefined means exit. */
  nextInput(): Promise<string | undefined> {
    if (this.state.exiting) return Promise.resolve(undefined);
    const [first, ...rest] = this.state.queue;
    if (first !== undefined) {
      this.update({ queue: rest });
      return Promise.resolve(first);
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  editLine(action: EditAction): void {
    this.update({ editor: edit(this.state.editor, action) });
  }

  /** Enter: run the line now, or queue it while a turn runs (type-ahead). */
  submitLine(): void {
    const { text, state } = submit(this.state.editor);
    this.update({ editor: state });
    if (text.trim() === "") return;
    if (this.waiting !== undefined && !this.state.busy) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(text);
    } else {
      this.update({ queue: [...this.state.queue, text] });
    }
  }

  /** Queue a line to run next, as if typed (garuda init). */
  enqueue(text: string): void {
    this.update({ queue: [...this.state.queue, text] });
  }

  /** Esc: drop queued lines. */
  /** Ctrl-P (0.9): open the command palette, or close it when it is open. */
  togglePalette(): void {
    if (this.state.palette !== undefined) {
      this.closePalette();
      return;
    }
    const all = this.paletteSource?.() ?? [];
    this.paletteAll = all;
    this.update({ palette: { query: "", entries: all, selected: 0 } });
  }

  closePalette(): void {
    const { palette: _closed, ...rest } = this.state;
    this.state = rest;
    for (const listener of this.listeners) listener();
  }

  /** Type into the palette's filter (text), or take a character off (null). */
  paletteQuery(text: string | null): void {
    const palette = this.state.palette;
    if (palette === undefined) return;
    const query = text === null ? palette.query.slice(0, -1) : palette.query + text;
    this.update({
      palette: { query, entries: filterPalette(this.paletteAll, query), selected: 0 },
    });
  }

  movePalette(delta: number): void {
    const palette = this.state.palette;
    if (palette === undefined || palette.entries.length === 0) return;
    const n = palette.entries.length;
    this.update({ palette: { ...palette, selected: (palette.selected + delta + n) % n } });
  }

  /** Enter: run the selected command, or put it in the input line for its arguments. */
  pickPalette(): void {
    const entry = this.state.palette?.entries[this.state.palette.selected];
    this.closePalette();
    if (entry === undefined) return;
    if (entry.runs) {
      this.editLine({ type: "set", text: `/${entry.name}`, cursor: entry.name.length + 1 });
      this.submitLine();
    } else {
      this.editLine({ type: "set", text: `/${entry.name} `, cursor: entry.name.length + 2 });
    }
  }

  clearQueue(): void {
    if (this.state.queue.length > 0) this.update({ queue: [] });
  }

  /**
   * Esc (0.6). During a turn: drop queued lines and stop the turn, like the first Ctrl-C. Esc never
   * exits Garuda: a second Esc while the turn stops does nothing.
   */
  stopTurn(): void {
    this.clearQueue();
    if (!this.state.busy || this.stopping) return;
    this.stopping = true;
    this.onInterrupt();
  }

  /** Tab (0.6): complete a /command or an @path at the cursor; several matches are listed. */
  completeLine(): void {
    const { text, cursor } = this.state.editor;
    const result = this.completer?.(text, cursor);
    if (result === undefined) return;
    this.editLine({ type: "set", text: result.text, cursor: result.cursor });
    if (result.candidates.length > 0) {
      this.info(result.candidates.join(result.lines === true ? "\n" : "  "));
    }
  }

  /** Ctrl-G or /editor (0.6): edit the input line in $VISUAL or $EDITOR. The text is not sent. */
  openEditor(): void {
    if (this.externalEdit === undefined) {
      this.warn("The external editor works only in the full chat on a terminal.");
      return;
    }
    const result = this.externalEdit(this.state.editor.text);
    if (result.problem !== undefined) this.warn(result.problem);
    if (result.text !== undefined) {
      this.editLine({ type: "clear" });
      this.editLine({ type: "insert", text: result.text });
    }
  }

  /**
   * Ctrl-C. During a turn: stop it (a second Ctrl-C exits, see runTurnInTerminal).
   * At the prompt: clear the line, or exit on a second Ctrl-C within 2 s.
   */
  interrupt(): void {
    if (this.state.busy) {
      this.stopping = true;
      this.onInterrupt();
      return;
    }
    if (this.state.editor.text !== "") {
      this.editLine({ type: "clear" });
      return;
    }
    if (this.now() - this.interruptAt < EXIT_WINDOW_MS) {
      this.exit();
      return;
    }
    this.interruptAt = this.now();
    this.info("Press Ctrl-C again to exit, or type /exit.");
  }

  /** Ctrl-D on an empty line, or the end of input. */
  exit(): void {
    this.update({ exiting: true });
    const resolve = this.waiting;
    this.waiting = undefined;
    resolve?.(undefined);
  }

  // A turn.

  /** Update the footer, for example after /plan. */
  refreshStatus(status: Status): void {
    this.update({ status });
  }

  /** Shift+Tab: the chat sets the handler; it switches the mode and returns the new status. */
  onToggleMode: (() => Status) | undefined;

  toggleMode(): void {
    const status = this.onToggleMode?.();
    if (status !== undefined) this.update({ status });
  }

  /** Start a turn. `show: false` when the line is already on screen (a custom command). */
  begin(prompt: string, show = true): void {
    if (show) this.add({ kind: "user", text: prompt });
    this.stopping = false;
    this.update({ busy: true });
  }

  end(status: Partial<Status>): void {
    this.flushText();
    this.stopping = false;
    this.update({ busy: false, running: [], status: { ...this.state.status, ...status } });
  }

  /** Print text as it is (it may hold its own colors), for example the start banner. */
  print(text: string): void {
    this.add({ kind: "output", text });
  }

  /** Echo a command line, for commands that do not start a turn. */
  echo(prompt: string): void {
    this.add({ kind: "user", text: prompt });
  }

  /** The terminal window got (true) or lost (false) focus (0.6). The Ink chat sets it. */
  onFocus: (focused: boolean) => void = () => {};

  /** Keep a long text for Ctrl-O, as for a tool call (0.6: /diff). */
  keepOutput(title: string, text: string): void {
    this.lastOutput = { title, text };
  }

  /** Ctrl-O: print the full output of the last tool call. */
  showLastOutput(): void {
    if (this.lastOutput === undefined) {
      this.info("No tool output yet.");
      return;
    }
    const { title, text } = this.lastOutput;
    this.add({ kind: "output", text: `${this.paint("bold", title)}\n${text}` });
  }

  // Renderer.

  event(event: AgentEvent): void {
    switch (event.type) {
      case "thinking_delta":
        this.thinking += event.text;
        return;
      case "text_delta": {
        this.flushThinking();
        const { blocks, rest } = takeBlocks(this.state.streaming + event.text);
        for (const block of blocks)
          this.add({ kind: "text", text: renderMarkdown(block, this.paint) });
        this.update({ streaming: rest });
        return;
      }
      case "tool_call":
        this.flushText();
        this.update({
          running: [
            ...this.state.running,
            { id: event.call.id, line: `${event.call.name} ${summariseCall(event.call)}` },
          ],
        });
        return;
      case "model_retry":
        // The request goes again: text that streamed but did not finish a block is void.
        this.update({ streaming: "" });
        this.warn(retryText(event));
        return;
      case "tool_progress": {
        // A subagent's current step: replace the live line of that call.
        const base = `${event.call.name} ${summariseCall(event.call)}`;
        this.update({
          running: this.state.running.map((r) =>
            r.id === event.call.id ? { ...r, line: `${base} · ${event.text}` } : r,
          ),
        });
        return;
      }
      case "tool_result": {
        const summary = summariseResult(event.call, event.outcome);
        const line = `${this.paint("cyan", "●")} ${this.paint("bold", event.call.name)} ${summariseCall(event.call)}`;
        const result = `  ${this.paint("dim", "⎿")} ${event.outcome.isError ? this.paint("red", summary) : this.paint("dim", summary)}`;
        const todos = todoLines(event.call, event.outcome).map((l) => `    ${l}`);
        const shown = this.details || event.outcome.isError ? [result] : [];
        this.add({ kind: "tool", text: [line, ...shown, ...todos].join("\n") });
        this.lastOutput = {
          title: `${event.call.name} ${summariseCall(event.call)}`,
          text: event.outcome.content,
        };
        this.update({ running: this.state.running.filter((r) => r.id !== event.call.id) });
        return;
      }
      case "compaction": {
        const { stage, beforeTokens, afterTokens } = event.result;
        this.info(`Context compacted (${stage}): ${beforeTokens} → about ${afterTokens} tokens.`);
        return;
      }
      case "step_end":
        this.flushText();
        return;
      case "notice":
        this.info(event.text);
        return;
      case "server_tool": {
        this.flushText();
        const { call, result } = serverToolText(event);
        const failed = event.result?.error !== undefined;
        const head = `${this.paint("cyan", "●")} ${this.paint("bold", call)}`;
        this.add({
          kind: "tool",
          text:
            this.details || failed
              ? `${head}\n  ${this.paint("dim", "⎿")} ${this.paint(failed ? "red" : "dim", result)}`
              : head,
        });
        this.lastOutput = { title: call, text: serverToolOutput(event) };
        return;
      }
    }
  }

  /** /details (0.9): show the result line of each tool call (errors always show). */
  details = true;

  info(text: string): void {
    this.note("info", text);
  }

  warn(text: string): void {
    this.note("warn", text);
  }

  error(text: string): void {
    this.note("error", text);
  }

  private note(level: "info" | "warn" | "error", text: string): void {
    this.flushText();
    const trimmed = text.replace(/^\n+/, "");
    const style = level === "info" ? "dim" : level === "warn" ? "yellow" : "red";
    this.add({ kind: "note", level, text: this.paint(style, trimmed) });
  }

  /** Readable thinking of the current block (0.9, /thinking show). */
  private thinking = "";

  /** Show the thinking so far as a dimmed item: the first lines, Ctrl-O for all (0.9). */
  private flushThinking(): void {
    const text = this.thinking.trim();
    this.thinking = "";
    if (text === "") return;
    this.add({ kind: "output", text: thinkingPreview(text, (s) => this.paint("dim", s)) });
    this.lastOutput = { title: "thinking", text };
  }

  private flushText(): void {
    this.flushThinking();
    const rest = this.state.streaming;
    if (rest.trim() !== "")
      this.add({ kind: "text", text: renderMarkdown(rest.trim(), this.paint) });
    if (rest !== "") this.update({ streaming: "" });
  }

  // Approver.

  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalChoice> {
    this.flushText();
    // The full preview goes to the scrollback; the live part only holds the choice.
    this.add({ kind: "output", text: `${header(request)}\n${colorPreview(request)}` });
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.answer = undefined;
        this.update({ approval: undefined });
        reject(signal.reason);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.answer = (choice) => {
        signal.removeEventListener("abort", onAbort);
        const label =
          this.state.approval?.choices.find((c) => c.choice === choice)?.label ?? choice;
        this.answer = undefined;
        this.update({ approval: undefined });
        this.add({
          kind: "note",
          level: "info",
          text:
            choice === "deny" ? this.paint("red", `✗ ${label}`) : this.paint("green", `✔ ${label}`),
        });
        resolve(choice);
      };
      const host = request.target.kind === "url" ? request.target.host : undefined;
      const shown = APPROVAL_CHOICES.filter((c) => request.choices?.includes(c.choice) ?? true);
      const choices = shown.map((c) => ({
        choice: c.choice,
        label:
          request.labels?.[c.choice] ??
          (c.choice === "session" && host !== undefined
            ? `Yes, allow ${host} for this session`
            : c.label),
      }));
      this.update({ approval: { request, choices, selected: 0 } });
    });
  }

  moveApproval(delta: number): void {
    const approval = this.state.approval;
    if (approval === undefined) return;
    const n = approval.choices.length;
    this.update({ approval: { ...approval, selected: (approval.selected + delta + n) % n } });
  }

  /** Answer with the highlighted choice, or with a given one. */
  choose(choice?: ApprovalChoice): void {
    const approval = this.state.approval;
    if (approval === undefined || this.answer === undefined) return;
    if (choice !== undefined && !approval.choices.some((c) => c.choice === choice)) return;
    this.answer(choice ?? approval.choices[approval.selected]?.choice ?? "deny");
  }

  /**
   * Enter hunk-by-hunk review (0.14). Only when the tool can apply single hunks (the request has
   * `selectHunks`, U0): otherwise the choice of hunks would not change what is written.
   */
  startHunkReview(): boolean {
    const approval = this.state.approval;
    if (approval === undefined || approval.request.selectHunks === undefined) return false;
    const fallback =
      approval.request.target.kind === "path" ? approval.request.target.path : "diff";
    const hunkReview = createHunkStaging(approval.request.preview, fallback);
    if (hunkReview === undefined) return false;
    this.update({ approval: { ...approval, hunkReview } });
    return true;
  }

  /** Exit hunk staging back to standard approval choice view. */
  closeHunkReview(): void {
    const approval = this.state.approval;
    if (approval === undefined || approval.hunkReview === undefined) return;
    this.update({ approval: { ...approval, hunkReview: undefined } });
  }

  /** Stage or unstage the current hunk in hunk review mode. */
  stageHunk(staged: boolean): void {
    const approval = this.state.approval;
    if (approval === undefined || approval.hunkReview === undefined) return;
    const { finished } = stageCurrentHunk(approval.hunkReview, staged);
    if (finished) {
      this.finishHunkReview();
    } else {
      this.update({ approval: { ...approval, hunkReview: { ...approval.hunkReview } } });
    }
  }

  /** Stage all remaining hunks and approve. */
  stageAllHunks(): void {
    const approval = this.state.approval;
    if (approval === undefined || approval.hunkReview === undefined) return;
    stageAllRemaining(approval.hunkReview);
    this.finishHunkReview();
  }

  /**
   * Answer from the staged hunks (U0): all staged = the whole change; none = deny; some = only those
   * hunks, passed to the tool through `selectHunks`, so a rejected hunk never reaches the disk.
   */
  private finishHunkReview(): void {
    const approval = this.state.approval;
    if (approval === undefined || approval.hunkReview === undefined) return;
    const staged = approval.hunkReview.hunks.filter((h) => h.staged).map((h) => h.id);
    if (staged.length === 0) {
      this.choose("deny");
      return;
    }
    if (staged.length < approval.hunkReview.hunks.length) {
      approval.request.selectHunks?.(staged);
    }
    this.choose("once");
  }

  /** Discard all hunks and deny. */
  discardAllHunks(): void {
    const approval = this.state.approval;
    if (approval === undefined || approval.hunkReview === undefined) return;
    discardAllHunks(approval.hunkReview);
    this.choose("deny");
  }

  /** Navigate between hunks in hunk review mode. */
  moveHunk(delta: number): void {
    const approval = this.state.approval;
    if (approval === undefined || approval.hunkReview === undefined) return;
    navigateHunk(approval.hunkReview, delta);
    this.update({ approval: { ...approval, hunkReview: { ...approval.hunkReview } } });
  }
}

/** Most thinking lines shown in the chat (0.9); Ctrl-O shows all. */
const THINKING_LINES = 4;

/** "✻ " and the first lines of the thinking, dimmed, with a hint when there is more (0.9). */
export function thinkingPreview(text: string, dim: (s: string) => string): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const shown = lines
    .slice(0, THINKING_LINES)
    .map((l) => (l.length > 160 ? `${l.slice(0, 159)}…` : l));
  const more =
    lines.length > THINKING_LINES
      ? [`… ${lines.length - THINKING_LINES} more line(s): Ctrl-O`]
      : [];
  return [...shown, ...more].map((l, i) => dim(`${i === 0 ? "✻" : " "} ${l}`)).join("\n");
}
