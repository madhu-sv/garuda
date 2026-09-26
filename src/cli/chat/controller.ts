import type { Runtime } from "../../app/runtime.js";
import { runTurnInTerminal } from "../turn.js";
import { runCommand } from "./commands.js";
import { BUILD_PROMPT, planHandoff } from "./plan.js";
import type { ChatStore, Status } from "./store.js";

/**
 * The Ink chat loop: take the next line (typed or queued), run a command or a turn,
 * then take the next one. It stops on /exit, Ctrl-D or two Ctrl-C.
 */
export async function runChat(
  runtime: Runtime,
  store: ChatStore,
  sessionPath: (id: string) => string,
  exitNow: () => never,
): Promise<void> {
  store.onToggleMode = () => {
    runtime.setMode(runtime.mode === "plan" ? "build" : "plan");
    return statusOf(runtime);
  };
  for (;;) {
    const input = await store.nextInput();
    if (input === undefined) return;
    const text = input.trim();
    let prompt = text;
    // Ctrl-G's command form (0.6): the edited text comes back into the input line, not sent.
    if (text === "/editor") {
      store.openEditor();
      continue;
    }
    if (text.startsWith("/")) {
      store.echo(text);
      const result = await runCommand(text, { runtime, renderer: store, sessionPath });
      store.refreshStatus(statusOf(runtime));
      if (result === "exit") return;
      if (result === "done") continue;
      // A custom command: the chat shows what was typed; the model gets the command's prompt.
      prompt = result.prompt;
    }
    let display = text;
    for (;;) {
      const planning = runtime.mode === "plan";
      store.begin(display, prompt === display);
      let outcome: Awaited<ReturnType<typeof runTurnInTerminal>>;
      try {
        outcome = await runTurnInTerminal(runtime, store, store, prompt, exitNow);
      } finally {
        store.end(statusOf(runtime));
      }
      // A finished plan: ask whether to build it.
      if (!planning || outcome.kind !== "done" || outcome.result.stopReason !== "done") break;
      const next = await planHandoff(runtime, store);
      store.refreshStatus(statusOf(runtime));
      if (next !== "now") break;
      prompt = BUILD_PROMPT;
      display = BUILD_PROMPT;
    }
  }
}

export function statusOf(runtime: Runtime): Status {
  const session = runtime.session;
  const status: Status = {
    model: runtime.modelId,
    sandbox:
      runtime.executor.isolation === "none" ? "no sandbox" : `sandbox ${runtime.executor.name}`,
    ...(runtime.mode === "plan" ? { mode: "plan" as const } : {}),
  };
  if (session !== undefined) {
    status.contextPercent = Math.round(
      (session.contextTokens / runtime.limits.contextWindow) * 100,
    );
    if (session.costUsd !== undefined) status.costUsd = session.costUsd;
  }
  return status;
}
