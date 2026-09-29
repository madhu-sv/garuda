import type { Runtime } from "../../app/runtime.js";
import { BUILTIN_COMMANDS } from "../../commands/builtins.js";
import { listJobs } from "../../jobs/job.js";
import { LSP_LANGUAGES } from "../../lsp/servers.js";
import { THINKING_WORDS } from "../../model/thinking.js";
import type { Notifier } from "../notify.js";
import { runTurnInTerminal } from "../turn.js";
import { paletteEntries, runCommand } from "./commands.js";
import { type ArgChoice, complete, rootFiles, rootLister } from "./complete.js";
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
  /** Tells the user when a long turn ends (0.6). */
  notifier?: Notifier,
): Promise<void> {
  store.onToggleMode = () => {
    runtime.setMode(runtime.mode === "plan" ? "build" : "plan");
    return statusOf(runtime);
  };
  const list = rootLister(runtime.root);
  const args = new CommandArgs(runtime);
  const files = rootFiles(runtime.root);
  store.paletteSource = () => paletteEntries(runtime);
  store.completer = (text, cursor) =>
    complete(text, cursor, {
      commands: commandNames(runtime),
      list,
      args: (command, before) => args.choices(command, before),
      files,
    });
  for (;;) {
    void args.refresh();
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
      // /compact (0.8) calls the model: busy while it runs, and Esc or Ctrl-C stops it.
      const slow = /^\/compact(\s|$)/.test(text);
      const controller = new AbortController();
      if (slow) {
        store.begin(text);
        store.onInterrupt = () => controller.abort();
      } else store.echo(text);
      let result: Awaited<ReturnType<typeof runCommand>>;
      try {
        result = await runCommand(text, {
          runtime,
          renderer: store,
          sessionPath,
          output: (shown, full) => {
            store.print(shown);
            if (full !== undefined) store.keepOutput(full.title, full.text);
          },
          signal: controller.signal,
        });
      } finally {
        if (slow) {
          store.onInterrupt = () => {};
          store.end(statusOf(runtime));
        }
      }
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
        outcome = await runTurnInTerminal(runtime, store, store, prompt, exitNow, notifier);
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

/**
 * The choices for command arguments (0.8, Tab). Sessions and jobs come from files, so they are read
 * before each input line (`refresh`) and kept; completion itself stays synchronous.
 */
export class CommandArgs {
  private sessions: ArgChoice[] = [];
  private jobs: ArgChoice[] = [];

  constructor(private readonly runtime: Runtime) {}

  async refresh(): Promise<void> {
    try {
      const { sessions } = await this.runtime.listSessions();
      this.sessions = sessions.map((s) => ({ value: s.id, hint: s.title }));
      const jobs = await listJobs(this.runtime.root);
      this.jobs = jobs.map((j) => ({ value: j.id, hint: `${j.status} · ${j.title}` }));
    } catch {
      // Completion is a help: a folder that cannot be read gives no choices.
    }
  }

  choices(command: string, before: readonly string[]): ArgChoice[] {
    const words = (...w: string[]) => w.map((value) => ({ value }));
    const [first, second] = before;
    switch (command) {
      case "models":
        if (first !== undefined) return [];
        return [
          ...words("opus", "sonnet", "haiku", "fable"),
          ...this.runtime.modelList().map((m) => ({ value: m.spec })),
        ];
      case "sessions":
        if (first === undefined) return [...words("rename", "delete"), ...this.sessions];
        return (first === "rename" || first === "delete") && second === undefined
          ? this.sessions
          : [];
      case "jobs":
        if (first === undefined) return [...words("cancel", "delete"), ...this.jobs];
        return (first === "cancel" || first === "delete") && second === undefined ? this.jobs : [];
      case "diff":
        return first === undefined ? words("last") : [];
      case "mcp":
        if (first === undefined) return words("logout");
        return first === "logout" && second === undefined
          ? this.runtime.mcpStatus().map((s) => ({ value: s.name }))
          : [];
      case "details":
        return first === undefined ? words("on", "off") : [];
      case "thinking":
        return first === undefined ? words(...THINKING_WORDS) : [];
      case "lsp":
        if (first === undefined) return words("install");
        return first === "install" && second === undefined ? words(...LSP_LANGUAGES) : [];
      default:
        return [];
    }
  }
}
