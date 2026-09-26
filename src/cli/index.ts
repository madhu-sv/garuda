import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { Runtime } from "../app/runtime.js";
import { replaySession } from "../loop/replay.js";
import { loadModelsConfig, type ResolvedModel, resolveModel } from "../model/providers.js";
import { FileSessionStore, parseRecords } from "../session/store.js";
import { defaultTools } from "../tools/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { VERSION } from "../version.js";
import { SwitchApprover, TerminalApprover } from "./approver.js";
import { banner, colorLevel } from "./banner.js";
import { describeError } from "./errors.js";
import { PlainRenderer, type Renderer } from "./renderer.js";
import { runRepl } from "./repl.js";
import { formatTokens } from "./report.js";
import { runTurnInTerminal } from "./turn.js";

/**
 * Entry point (F1, F2):
 *   garuda                      chat in the current folder
 *   garuda -p "task"            run one task and exit (also: echo "task" | garuda)
 *   garuda --resume [id]        continue a session (chat, or one task with -p)
 *   garuda --replay <id|file>   replay a session with no API calls
 *   garuda eval                 run the eval tasks (N5)
 *   garuda lsp [install <lang>] language servers for diagnostics (0.4)
 */

interface Options {
  prompt?: string;
  plan?: boolean;
  lsp?: boolean;
  model?: string;
  subagentModel?: string;
  resume?: string | true;
  replay?: string;
}

async function main(): Promise<void> {
  const program = new Command()
    // Options after a subcommand belong to the subcommand: `garuda eval -m x` sets eval's model.
    .enablePositionalOptions()
    .name("garuda")
    .description("A terminal coding agent. With no task, it starts a chat in the current folder.")
    .version(VERSION)
    .option("-p, --prompt <task>", "run one task and exit")
    .option("-m, --model <id>", "model id (or set GARUDA_MODEL)")
    .option(
      "--subagent-model <id>",
      "model of the explore subagent (or set GARUDA_SUBAGENT_MODEL); default: the main model",
    )
    .option("--plan", "start in plan mode: read and plan, change nothing")
    .option("--lsp", "add language server errors to edit results (TS/JS, Python, Java)")
    .option("-r, --resume [session-id]", "continue the last session, or the given one")
    .option("--replay <session-id-or-file>", "replay a recorded session with no API calls")
    .action(async (options: Options) => {
      process.exitCode = await start(options, program);
    });

  program
    .command("eval")
    .description("run the eval tasks in scratch folders and report pass/fail, steps and cost")
    .option("-m, --model <id>", "model id (or set GARUDA_MODEL)")
    .option("-s, --suite <name>", "basic (default), hard, java, python or all")
    .option("-t, --task <ids...>", "run only these tasks (from any suite)")
    .option("--max-steps <n>", "step limit per task", (v) => Number.parseInt(v, 10))
    .option("--repeat <n>", "run each task n times and show the mean", (v) =>
      Number.parseInt(v, 10),
    )
    .option("--index <mode>", "code index tools for the model: off (default), lookup or all")
    .option("--executor <name>", "auto (default), os or host")
    .option("--keep", "keep the scratch folders")
    .option("--list", "list the tasks and exit")
    .option("--subagents <mode>", "the explore subagent: off (default) or on, for A/B runs")
    .option("--subagent-model <id>", "model of the explore subagent; default: the main model")
    .option("--todo <mode>", "the todo_write tool: off (default) or on, for A/B runs")
    .option("--lsp <mode>", "language server errors in edit results: off (default) or on")
    .option(
      "--prepare <toolchain>",
      "java: download Maven plugins and JUnit once; python: check pytest",
    )
    .action(async (options) => {
      const { runEvalCommand } = await import("./evalCommand.js");
      process.exitCode = await runEvalCommand({
        ...options,
        model: options.model ?? process.env.GARUDA_MODEL,
        subagentModel: options.subagentModel ?? process.env.GARUDA_SUBAGENT_MODEL,
      });
    });

  const lsp = program
    .command("lsp")
    .description("show the language servers for diagnostics (TS/JS, Python, Java)")
    .action(async () => {
      const { lspStatusCommand } = await import("./lspCommand.js");
      process.exitCode = await lspStatusCommand();
    });
  lsp
    .command("install")
    .description("install a pinned language server into ~/.garuda/lsp (needs the network)")
    .argument("<language>", "typescript, python or java")
    .action(async (language: string) => {
      const { lspInstallCommand } = await import("./lspCommand.js");
      process.exitCode = await lspInstallCommand(language);
    });

  await program.parseAsync();
}

async function start(options: Options, program: Command): Promise<number> {
  const root = realpathSync(process.cwd());
  const store = new FileSessionStore(root);
  if (options.replay !== undefined) return replay(options.replay, store);

  // A task on stdin works like -p: echo "task" | garuda
  let prompt = options.prompt;
  if (prompt === undefined && !process.stdin.isTTY) prompt = readFileSync(0, "utf8").trim();
  if (prompt === "") program.error("The task is empty.");

  const spec = options.model ?? process.env.GARUDA_MODEL;
  if (!spec) program.error("Set a model with --model <id> or the GARUDA_MODEL variable.");
  // Providers come only from the user's own ~/.garuda/models.json (never from the project).
  const models = await loadModelsConfig();
  if (models.problem !== undefined) program.error(models.problem);
  let resolved: ResolvedModel;
  try {
    resolved = resolveModel(spec as string, models.config);
  } catch (error) {
    program.error((error as Error).message);
  }
  const modelId = resolved.spec;
  const subSpec = options.subagentModel ?? process.env.GARUDA_SUBAGENT_MODEL;
  let sub: ResolvedModel | undefined;
  if (subSpec) {
    try {
      sub = resolveModel(subSpec, models.config);
    } catch (error) {
      program.error((error as Error).message);
    }
  }

  const renderer = new PlainRenderer();
  const terminalApprover = new TerminalApprover();
  const approver = new SwitchApprover(terminalApprover);
  // Agent events go to the plain renderer, or to the Ink chat once it starts.
  let events: Renderer = renderer;
  const runtime = await Runtime.create({
    root,
    modelId,
    model: () => resolved.create(),
    modelInfo: resolved.info,
    ...(resolved.maxTokens === undefined ? {} : { maxTokens: resolved.maxTokens }),
    ...(sub === undefined
      ? {}
      : { subagentModel: { spec: sub.spec, model: () => sub.create(), info: sub.info } }),
    approver,
    store,
    ...(options.plan === true ? { mode: "plan" as const } : {}),
    ...(options.lsp === true ? { lsp: { enabled: true } } : {}),
    // Undo snapshots are on for the chat and for -p (a later chat can undo the task).
    undo: {},
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    onEvent: (event) => events.event(event),
    onNotice: (text) => events.warn(text),
  });

  // No orphan process stays (F4): kill running commands on any exit.
  process.on("exit", () => runtime.executor.shutdown());
  const exitNow = (): never => {
    runtime.executor.shutdown();
    process.exit(130);
  };

  if (runtime.executorNotice !== undefined) renderer.warn(runtime.executorNotice);
  const session = runtime.session;
  if (session !== undefined) {
    renderer.info(
      `Resumed session ${session.id} (${session.messages.length} messages, ${formatTokens(session.contextTokens)} tokens of context).`,
    );
  }
  for (const note of resolved.notes) renderer.info(note);
  if (runtime.price === undefined) {
    renderer.warn(
      `Garuda has no price for ${modelId}. Set "price" for it in ~/.garuda/models.json to see cost.`,
    );
  }

  if (prompt !== undefined) {
    // `garuda -p "/review src"` runs a custom command; other text goes to the model as it is.
    if (prompt.startsWith("/")) {
      const resolved = await runtime.resolveCommand(prompt, new AbortController().signal);
      if (resolved.kind === "denied") {
        renderer.info(resolved.message);
        await runtime.close();
        return 1;
      }
      if (resolved.kind === "prompt") prompt = resolved.prompt;
    }
    const outcome = await runTurnInTerminal(runtime, terminalApprover, renderer, prompt, exitNow);
    await runtime.close();
    if (outcome.kind === "interrupted") return 130;
    if (outcome.kind === "error") return 1;
    return outcome.result.stopReason === "done" ? 0 : 2;
  }

  const ink = wantsInk() ? await loadInk(renderer) : undefined;
  const bannerInfo = {
    version: VERSION,
    model: modelId,
    sandbox:
      runtime.executor.isolation === "none"
        ? "none: each command asks first"
        : `${runtime.executor.name} · no network`,
    root,
    extras: runtime.extras(),
    ink: ink !== undefined,
  };
  const startBanner = banner(bannerInfo, {
    columns: process.stdout.columns || 80,
    color: colorLevel(process.stdout),
  });
  const sessionPath = (id: string) => join(store.dir, `${id}.jsonl`);
  if (ink !== undefined) {
    const setEventTarget = (target: Renderer) => {
      events = target;
    };
    await ink.runInkChat(runtime, approver, setEventTarget, startBanner, sessionPath, exitNow);
  } else {
    process.stderr.write(`${startBanner}\n`);
    await runRepl(runtime, terminalApprover, renderer, sessionPath, exitNow);
  }
  await runtime.close();
  const id = runtime.session?.id;
  if (id !== undefined) renderer.info(`Session ${id}. Continue it with: garuda --resume ${id}`);
  return 0;
}

/** The Ink chat needs a terminal on both sides. GARUDA_PLAIN=1 turns it off. */
function wantsInk(): boolean {
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    process.env.GARUDA_PLAIN !== "1" &&
    process.env.TERM !== "dumb"
  );
}

/** Ink loads on demand (N3). The standalone binary has no Ink: it uses the plain chat. */
async function loadInk(
  renderer: PlainRenderer,
): Promise<typeof import("./chat/inkChat.js") | undefined> {
  try {
    return await import("./chat/inkChat.js");
  } catch (error) {
    renderer.info(`Plain chat (Ink is not available: ${(error as Error).message.split("\n")[0]}).`);
    return undefined;
  }
}

/** --replay: play a session back with a fake model and recorded tool results (F26). */
async function replay(target: string, store: FileSessionStore): Promise<number> {
  const records = existsSync(target)
    ? parseRecords(readFileSync(target, "utf8"))
    : await store.read(target);
  const report = await replaySession(records, new ToolRegistry(defaultTools()));
  const summary = `${report.runs} run(s), ${report.steps} step(s), ${report.toolCalls} tool call(s)`;
  if (report.matches) {
    process.stdout.write(`Replay matches the recording: ${summary}.\n`);
    return 0;
  }
  process.stdout.write(`Replay does not match the recording (${summary}):\n`);
  for (const problem of report.problems) process.stdout.write(`  - ${problem}\n`);
  return 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`Error: ${describeError(error)}\n`);
  process.exitCode = 1;
});
