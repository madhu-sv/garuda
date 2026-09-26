import type { Runtime } from "../../app/runtime.js";
import { BUILTIN_COMMANDS } from "../../commands/builtins.js";
import { runTurnInTerminal } from "../turn.js";
import { runCommand } from "./commands.js";
import { complete, rootLister } from "./complete.js";
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
  const list = rootLister(runtime.root);
  store.completer = (text, cursor) =>
    complete(text, cursor, { commands: commandNames(runtime), list });
  for (;;) {
    const input = await store.nextInput();
    if (input === undefined) return;
    const text = input.trim();
    let prompt = text;
    // !command (0.6): run it like the bash tool; the output also goes with the next message.
    if (text.startsWith("!") && text.length > 1) {
      await runShell(runtime, store, text.slice(1).trim());
      continue;
    }
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

/** Names for Tab completion: built-in commands, custom commands and skills that the user can run. */
export function commandNames(runtime: Runtime): string[] {
  return [
    ...BUILTIN_COMMANDS,
    ...runtime.commands.map((c) => c.name),
    ...runtime.skills.filter((s) => s.userInvocable).map((s) => s.name),
  ];
}

/** `!command` in the Ink chat: busy while it runs, Esc or Ctrl-C stops it. */
async function runShell(runtime: Runtime, store: ChatStore, command: string): Promise<void> {
  const controller = new AbortController();
  store.begin(`!${command}`);
  store.onInterrupt = () => controller.abort();
  try {
    const result = await runtime.runUserCommand(command, controller.signal);
    store.print(result.text);
    store.info("The output goes to the model with your next message.");
  } catch (error) {
    store.warn(controller.signal.aborted ? "Command stopped." : (error as Error).message);
  } finally {
    store.onInterrupt = () => {};
    store.end(statusOf(runtime));
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
