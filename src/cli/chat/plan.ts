import type { Runtime } from "../../app/runtime.js";
import type { ApprovalRequest, Approver } from "../../permissions/types.js";

/** The prompt that starts the build after the user accepts a plan (0.4). */
export const BUILD_PROMPT = "Carry out the plan above.";

/**
 * After a plan-mode turn: ask whether to build the plan.
 *   now   → build mode, and the chat runs BUILD_PROMPT at once
 *   later → build mode; the user types the next task
 *   stay  → plan mode stays on
 */
export async function planHandoff(
  runtime: Runtime,
  approver: Approver,
  signal: AbortSignal = new AbortController().signal,
): Promise<"now" | "later" | "stay"> {
  const request: ApprovalRequest = {
    tool: "plan",
    target: { kind: "input", json: "{}" },
    preview:
      "Build mode can change files and run commands, with the usual approvals and sandbox. To build it later, unattended, choose No and type /schedule.",
    isolation: runtime.executor.isolation,
    title: "The plan is ready.",
    question: "Build this plan?",
    labels: {
      once: "Yes, build it now",
      session: "Switch to build mode; I will type the task",
      deny: "No, keep planning",
    },
  };
  const choice = await approver.ask(request, signal);
  if (choice === "deny") return "stay";
  runtime.setMode("build");
  return choice === "once" ? "now" : "later";
}

/** The text for /plan and /build. */
export function modeText(runtime: Runtime): string {
  if (runtime.mode !== "plan") {
    return "Build mode: the agent can change files and run commands, with the usual approvals.";
  }
  // With no OS sandbox, plan mode cannot run commands read-only, so it blocks them (the permission
  // engine denies a command when isolation is "none"). Saying "read-only in the sandbox" there was
  // wrong (2026-11 review, P2).
  const commands =
    runtime.executor.isolation === "none"
      ? "It cannot change files, and commands do not run (there is no sandbox here to run them read-only)."
      : "It cannot change files; commands run read-only in the sandbox.";
  return `Plan mode: the agent reads and plans. ${commands} /build (or Shift+Tab) switches back.`;
}
