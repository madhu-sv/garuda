import type { Runtime } from "../../app/runtime.js";
import { runTurnInTerminal } from "../turn.js";
import { runCommand } from "./commands.js";
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
  for (;;) {
    const input = await store.nextInput();
    if (input === undefined) return;
    const text = input.trim();
    if (text.startsWith("/")) {
      store.echo(text);
      if ((await runCommand(text, { runtime, renderer: store, sessionPath })) === "exit") return;
      continue;
    }
    store.begin(text);
    try {
      await runTurnInTerminal(runtime, store, store, text, exitNow);
    } finally {
      store.end(statusOf(runtime));
    }
  }
}

export function statusOf(runtime: Runtime): Status {
  const session = runtime.session;
  const status: Status = {
    model: runtime.modelId,
    sandbox:
      runtime.executor.isolation === "none" ? "no sandbox" : `sandbox ${runtime.executor.name}`,
  };
  if (session !== undefined) {
    status.contextPercent = Math.round(
      (session.contextTokens / runtime.limits.contextWindow) * 100,
    );
    if (session.costUsd !== undefined) status.costUsd = session.costUsd;
  }
  return status;
}
