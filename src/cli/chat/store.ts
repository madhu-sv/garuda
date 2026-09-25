import type { AgentEvent } from "../../loop/runAgent.js";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../../permissions/types.js";
import { colorPreview, header } from "../approver.js";
import type { Renderer } from "../renderer.js";
import { retryText, summariseCall, summariseResult, todoLines } from "../renderer.js";
import type { Interruptible } from "../turn.js";
import { type EditAction, type EditorState, edit, emptyEditor, submit } from "./lineEditor.js";
import { ansi, type Paint, renderMarkdown, takeBlocks } from "./markdown.js";

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
  /** The three choices, with the request's own labels. */
  choices: { choice: ApprovalChoice; label: string }[];
  /** The highlighted choice. */
  selected: number;
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
  private interruptAt = 0;
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

  /** Esc: drop queued lines. */
  clearQueue(): void {
    if (this.state.queue.length > 0) this.update({ queue: [] });
  }

  /**
   * Ctrl-C. During a turn: stop it (a second Ctrl-C exits, see runTurnInTerminal).
   * At the prompt: clear the line, or exit on a second Ctrl-C within 2 s.
   */
  interrupt(): void {
    if (this.state.busy) {
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
    this.update({ busy: true });
  }

  end(status: Partial<Status>): void {
    this.flushText();
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
      case "text_delta": {
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
        this.add({ kind: "tool", text: [line, result, ...todos].join("\n") });
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
    }
  }

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

  private flushText(): void {
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
      const choices = APPROVAL_CHOICES.map((c) => ({
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
    const n = APPROVAL_CHOICES.length;
    this.update({ approval: { ...approval, selected: (approval.selected + delta + n) % n } });
  }

  /** Answer with the highlighted choice, or with a given one. */
  choose(choice?: ApprovalChoice): void {
    const approval = this.state.approval;
    if (approval === undefined || this.answer === undefined) return;
    this.answer(choice ?? approval.choices[approval.selected]?.choice ?? "deny");
  }
}
