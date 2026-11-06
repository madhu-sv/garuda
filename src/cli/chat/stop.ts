import type { ApprovalRequest, Approver } from "../../permissions/types.js";
import type { Isolation } from "../../sandbox/types.js";

/** The prompt after "Go on" (UX U3): the model goes on with the same task. */
export const CONTINUE_PROMPT =
  "Go on with the task from where you stopped. You reached the step limit; the conversation above has your work so far.";

/** The prompt after "Summarise" (UX U3): no more work, only where things are. */
export const SUMMARY_PROMPT =
  "Stop the work here and do not call tools. Say what is done, what is left, and the next step.";

/**
 * After a chat turn that hit the step limit (UX U3): ask how to go on. Enter (the first choice)
 * goes on for another `maxSteps` steps.
 */
export async function stopHandoff(
  approver: Approver,
  maxSteps: number,
  isolation: Isolation,
  signal: AbortSignal = new AbortController().signal,
): Promise<"more" | "summary" | "stop"> {
  const request: ApprovalRequest = {
    tool: "step_limit",
    target: { kind: "input", json: "{}" },
    preview: `The turn used its ${maxSteps} steps. The next turn gets ${maxSteps} more.`,
    isolation,
    title: "The task is not finished.",
    question: "Go on?",
    labels: {
      once: `Go on for ${maxSteps} more steps`,
      session: "Summarise what is done and what is left",
      deny: "Stop here",
    },
  };
  const choice = await approver.ask(request, signal);
  return choice === "once" ? "more" : choice === "session" ? "summary" : "stop";
}
