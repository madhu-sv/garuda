import type {
  PermissionOption,
  PermissionOptionKind,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import { HIDDEN_WARNING, hasHidden, headerText, visible } from "../cli/approver.js";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../permissions/types.js";
import { oneLine } from "./toolCalls.js";
import { type KnownCalls, type SessionChannel, textContent } from "./updates.js";

/** The diff view gets both texts only below this size (old + new), in characters. */
export const DIFF_MAX_CHARS = 1_000_000;

const DEFAULT_CHOICES: readonly ApprovalChoice[] = ["once", "session", "deny"];
const KINDS: Readonly<Record<ApprovalChoice, PermissionOptionKind>> = {
  once: "allow_once",
  session: "allow_always",
  deny: "reject_once",
};
const NAMES: Readonly<Record<ApprovalChoice, string>> = {
  once: "Allow once",
  // "Always" in Garuda is this session only (session rules), as in the terminal.
  session: "Allow for this session",
  deny: "Deny",
};

/**
 * Asks the editor with `session/request_permission` (ACP, 0.15). The question names the tool call
 * that asks (`callId`); a question that is not about a known call (a consent) gets its own entry.
 * Hidden characters are made visible, as in the terminal. Any answer but a known choice is "deny",
 * and so is an aborted turn: Garuda does not wait for the editor then.
 */
export class AcpApprover implements Approver {
  private questions = 0;

  constructor(
    private readonly channel: SessionChannel,
    private readonly calls: KnownCalls,
  ) {}

  async ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalChoice> {
    const client = this.channel.current;
    if (client === undefined || signal.aborted) return "deny";
    const known = request.callId === undefined ? undefined : this.calls.title(request.callId);
    const toolCallId =
      known !== undefined && request.callId !== undefined
        ? request.callId
        : `garuda-question-${++this.questions}`;
    const title = oneLine(request.title ?? known ?? headerText(request).replace(/:$/, ""));
    if (known === undefined) {
      this.channel.update({
        sessionUpdate: "tool_call",
        toolCallId,
        title,
        kind: "other",
        status: "pending",
      });
    }
    // The tool call must reach the editor before its question.
    await this.channel.flush();

    const choices = request.choices ?? DEFAULT_CHOICES;
    const options: PermissionOption[] = choices.map((choice) => ({
      optionId: choice,
      name: request.labels?.[choice] ?? NAMES[choice],
      kind: KINDS[choice],
    }));
    const answer = client
      .request("session/request_permission", {
        sessionId: this.channel.sessionId,
        toolCall: { toolCallId, title, status: "pending", content: questionContent(request) },
        options,
      })
      .catch(() => undefined);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const response = await Promise.race([answer, aborted]);
      if (response === undefined || response.outcome.outcome !== "selected") return "deny";
      const picked = response.outcome.optionId;
      return choices.find((c) => c === picked) ?? "deny";
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }
}

/** The question's content: the editor's diff view for a file write, then the text preview. */
function questionContent(request: ApprovalRequest): ToolCallContent[] {
  const content: ToolCallContent[] = [];
  const change = request.change;
  if (
    change !== undefined &&
    (change.oldText?.length ?? 0) + change.newText.length <= DIFF_MAX_CHARS
  ) {
    content.push({
      type: "diff",
      path: change.path,
      oldText: change.oldText,
      newText: change.newText,
    });
  }
  const lines = [headerText(request)];
  if (request.question !== undefined) lines.push(visible(request.question));
  const preview = request.target.kind === "command" ? `$ ${request.preview}` : request.preview;
  lines.push(visible(preview));
  if (hasHidden(request.preview)) lines.push(HIDDEN_WARNING);
  content.push(textContent(lines.join("\n")));
  return content;
}
