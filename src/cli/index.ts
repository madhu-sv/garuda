import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { Runtime } from "../app/runtime.js";
import { replaySession } from "../loop/replay.js";
import type { ModelClient } from "../model/types.js";
import { FileSessionStore, parseRecords } from "../session/store.js";
import { defaultTools } from "../tools/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { VERSION } from "../version.js";
import { TerminalApprover } from "./approver.js";
import { describeError } from "./errors.js";
import { PlainRenderer } from "./renderer.js";
import { HELP, runRepl } from "./repl.js";
import { formatTokens } from "./report.js";
import { runTurnInTerminal } from "./turn.js";

/**
 * Entry point (F1, F2):
 *   garuda                      chat in the current folder
 *   garuda -p "task"            run one task and exit (also: echo "task" | garuda)
 *   garuda --resume [id]        continue a session (chat, or one task with -p)
 *   garuda --replay <id|file>   replay a session with no API calls
 *   garuda eval                 run the eval tasks (N5)
 */

interface Options {
  prompt?: string;
  model?: string;
  resume?: string | true;
  replay?: string;
}

/** The Anthropic SDK loads on the first model call, not at startup (N3). */
const lazyModel = (modelId: string) => async (): Promise<ModelClient> => {
  const { AnthropicClient } = await import("../model/anthropic.js");
  return new AnthropicClient({ model: modelId });
};

async function main(): Promise<void> {
  const program = new Command()
    // Options after a subcommand belong to the subcommand: `garuda eval -m x` sets eval's model.
    .enablePositionalOptions()
    .name("garuda")
    .description("A terminal coding agent. With no task, it starts a chat in the current folder.")
    .version(VERSION)
    .option("-p, --prompt <task>", "run one task and exit")
    .option("-m, --model <id>", "model id (or set GARUDA_MODEL)")
    .option("-r, --resume [session-id]", "continue the last session, or the given one")
    .option("--replay <session-id-or-file>", "replay a recorded session with no API calls")
    .action(async (options: Options) => {
      process.exitCode = await start(options, program);
    });

  program
    .command("eval")
    .description("run the eval tasks in scratch folders and report pass/fail, steps and cost")
    .option("-m, --model <id>", "model id (or set GARUDA_MODEL)")
    .option("-s, --suite <name>", "basic (default), hard or all")
    .option("-t, --task <ids...>", "run only these tasks (from any suite)")
    .option("--max-steps <n>", "step limit per task", (v) => Number.parseInt(v, 10))
    .option("--repeat <n>", "run each task n times and show the mean", (v) =>
      Number.parseInt(v, 10),
    )
    .option("--index <mode>", "code index tools for the model: off (default), lookup or all")
    .option("--keep", "keep the scratch folders")
    .option("--list", "list the tasks and exit")
    .action(async (options) => {
      const { runEvalCommand } = await import("./evalCommand.js");
      process.exitCode = await runEvalCommand({
        ...options,
        model: options.model ?? process.env.GARUDA_MODEL,
      });
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

  const modelId = options.model ?? process.env.GARUDA_MODEL;
  if (!modelId) program.error("Set a model with --model <id> or the GARUDA_MODEL variable.");

  const renderer = new PlainRenderer();
  const approver = new TerminalApprover();
  const runtime = await Runtime.create({
    root,
    modelId: modelId as string,
    model: lazyModel(modelId as string),
    approver,
    store,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    onEvent: (event) => renderer.event(event),
  });

  // No orphan process stays (F4): kill running commands on any exit.
  process.on("exit", () => runtime.executor.shutdown());
  const exitNow = (): never => {
    runtime.executor.shutdown();
    process.exit(130);
  };

  const session = runtime.session;
  if (session !== undefined) {
    renderer.info(
      `Resumed session ${session.id} (${session.messages.length} messages, ${formatTokens(session.contextTokens)} tokens of context).`,
    );
  }
  if (runtime.price === undefined) {
    renderer.warn(
      `Garuda has no price for ${modelId}. Set model.price in .garuda/settings.json to see cost.`,
    );
  }

  if (prompt !== undefined) {
    const outcome = await runTurnInTerminal(runtime, approver, renderer, prompt, exitNow);
    if (outcome.kind === "interrupted") return 130;
    if (outcome.kind === "error") return 1;
    return outcome.result.stopReason === "done" ? 0 : 2;
  }

  renderer.info(`Garuda ${VERSION} · ${modelId} · ${root}\n${HELP}\n`);
  await runRepl(runtime, approver, renderer, (id) => join(store.dir, `${id}.jsonl`), exitNow);
  const id = runtime.session?.id;
  if (id !== undefined) renderer.info(`Session ${id}. Continue it with: garuda --resume ${id}`);
  return 0;
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
