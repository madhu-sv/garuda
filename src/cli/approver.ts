import { styleText } from "node:util";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../permissions/types.js";

/**
 * Asks the user in the terminal (F18): allow once, allow for this session, or deny.
 * With no terminal on stdin (a pipe, CI), nobody can answer, so it denies.
 * Ctrl-C during the question stops the turn (F4): `onInterrupt` aborts it.
 */
export class TerminalApprover implements Approver {
  /** Set by the CLI: it aborts the current turn. */
  onInterrupt: () => void = () => {};

  async ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalChoice> {
    const out = process.stderr;
    out.write(`\n${header(request)}\n${colorPreview(request)}\n`);

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

export function header({ tool, target, isolation, title }: ApprovalRequest): string {
  if (title !== undefined) return styleText("bold", title);
  if (target.kind === "command") {
    const where =
      isolation === "none"
        ? "on your machine, no sandbox"
        : target.outsideSandbox
          ? "OUTSIDE the sandbox: network on, writes anywhere"
          : `sandbox: ${isolation}`;
    return styleText("bold", `${tool} wants to run a command (${where}):`);
  }
  if (target.kind === "input") return styleText("bold", `${tool} wants to run with this input:`);
  if (target.kind === "url")
    return styleText("bold", `${tool} wants to fetch from ${target.host}:`);
  return styleText("bold", `${tool} wants to change ${target.path}:`);
}

export function colorPreview({ target, preview }: ApprovalRequest): string {
  if (target.kind === "command") return styleText("cyan", `  $ ${preview}`);
  if (target.kind === "url") return preview;
  return colorDiff(preview);
}

/** A unified diff with colors: + green, - red, hunk headers cyan, file headers bold. */
export function colorDiff(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git"))
        return styleText("bold", line);
      if (line.startsWith("+")) return styleText("green", line);
      if (line.startsWith("-")) return styleText("red", line);
      if (line.startsWith("@@")) return styleText("cyan", line);
      return line;
    })
    .join("\n");
}
