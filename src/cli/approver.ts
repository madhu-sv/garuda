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
      request.target.kind === "command"
        ? "Yes, and allow this exact command for this session"
        : `Yes, and allow all ${request.tool} calls for this session`;

    // Loaded on first use, so startup stays fast (N3).
    const { select } = await import("@inquirer/prompts");
    try {
      return await select<ApprovalChoice>(
        {
          message: "Allow?",
          choices: [
            { name: "Yes, once", value: "once" },
            { name: sessionLabel, value: "session" },
            { name: "No, deny", value: "deny" },
          ],
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
  constructor(public current: Approver) {}

  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalChoice> {
    return this.current.ask(request, signal);
  }
}

export function header({ tool, target, isolation }: ApprovalRequest): string {
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
  return styleText("bold", `${tool} wants to change ${target.path}:`);
}

export function colorPreview({ target, preview }: ApprovalRequest): string {
  if (target.kind === "command") return styleText("cyan", `  $ ${preview}`);
  return preview
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return styleText("bold", line);
      if (line.startsWith("+")) return styleText("green", line);
      if (line.startsWith("-")) return styleText("red", line);
      if (line.startsWith("@@")) return styleText("cyan", line);
      return line;
    })
    .join("\n");
}
