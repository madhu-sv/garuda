import { styleText } from "node:util";
import { select } from "@inquirer/prompts";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../permissions/types.js";

/**
 * Asks the user in the terminal (F18): allow once, allow for this session, or deny.
 * With no terminal on stdin (a pipe, CI), nobody can answer, so it denies.
 */
export class TerminalApprover implements Approver {
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

    return select<ApprovalChoice>(
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
  }
}

function header({ tool, target, isolation }: ApprovalRequest): string {
  if (target.kind === "command") {
    const where = isolation === "none" ? "on your machine, no sandbox" : `sandbox: ${isolation}`;
    return styleText("bold", `${tool} wants to run a command (${where}):`);
  }
  if (target.kind === "input") return styleText("bold", `${tool} wants to run with this input:`);
  return styleText("bold", `${tool} wants to change ${target.path}:`);
}

function colorPreview({ target, preview }: ApprovalRequest): string {
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
