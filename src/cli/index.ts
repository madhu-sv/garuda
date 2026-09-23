import { existsSync, readFileSync, realpathSync } from "node:fs";
import { Command } from "commander";
import { buildSystemPrompt, loadInstructions } from "../context/instructions.js";
import { replaySession } from "../loop/replay.js";
import { DEFAULT_MAX_STEPS, DEFAULT_TOKEN_BUDGET, runAgent } from "../loop/runAgent.js";
import { AnthropicClient } from "../model/anthropic.js";
import { lookupModel } from "../model/pricing.js";
import { PermissionEngine } from "../permissions/engine.js";
import { loadSettings } from "../permissions/settings.js";
import { createExecutor } from "../sandbox/index.js";
import type { RunLimits } from "../session/records.js";
import { resumeSession } from "../session/resume.js";
import { addUserMessage, createSession } from "../session/session.js";
import { FileSessionStore, newSessionId, parseRecords } from "../session/store.js";
import { defaultTools } from "../tools/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { VERSION } from "../version.js";
import { TerminalApprover } from "./approver.js";
import { describeError, greeting } from "./greeting.js";
import { formatTokens, stopMessage, usageLine } from "./report.js";

/**
 * Entry point: a greeting with no task, one-shot mode with -p, --resume and --replay.
 * M5 adds interactive mode, full Ctrl-C handling and the renderer (F1–F4).
 */

interface Options {
  prompt?: string;
  model?: string;
  resume?: string | true;
  replay?: string;
}

async function main(): Promise<void> {
  const program = new Command()
    .name("garuda")
    .description("A terminal coding agent.")
    .version(VERSION)
    .option("-p, --prompt <task>", "run one task and exit")
    .option("-m, --model <id>", "model id (or set GARUDA_MODEL)")
    .option("-r, --resume [session-id]", "continue the last session, or the given one (with -p)")
    .option("--replay <session-id-or-file>", "replay a recorded session with no API calls")
    .parse();

  const options = program.opts<Options>();
  const root = realpathSync(process.cwd());
  const store = new FileSessionStore(root);

  if (options.replay !== undefined) {
    process.exitCode = await replay(options.replay, store);
    return;
  }
  if (options.prompt === undefined) {
    if (options.resume !== undefined) {
      program.error("Give the next task with -p. Interactive mode comes in M5.");
    }
    process.stdout.write(greeting());
    return;
  }

  const modelId = options.model ?? process.env.GARUDA_MODEL;
  if (!modelId) {
    program.error("Set a model with --model <id> or the GARUDA_MODEL variable.");
    return;
  }

  const settings = await loadSettings(root);
  const info = lookupModel(modelId);
  const price = settings.price ?? info.price;
  const limits: RunLimits = {
    maxSteps: settings.maxSteps ?? DEFAULT_MAX_STEPS,
    tokenBudget: settings.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    contextWindow: settings.contextWindow ?? info.contextWindow,
  };
  const executor = createExecutor(settings.executor);
  const permissions = new PermissionEngine({
    root,
    settings,
    approver: new TerminalApprover(),
    isolation: executor.isolation,
  });
  const system = buildSystemPrompt(root, await loadInstructions(root));
  const start = {
    root,
    version: VERSION,
    model: modelId,
    executor: executor.name,
    isolation: executor.isolation,
    limits,
  };

  let session: Awaited<ReturnType<typeof resumeSession>>;
  if (options.resume !== undefined) {
    session = await resumeSession({
      store,
      root,
      start,
      ...(options.resume === true ? {} : { sessionId: options.resume }),
    });
    process.stderr.write(
      `Resumed session ${session.id} (${session.messages.length} messages, ${formatTokens(session.contextTokens)} tokens of context).\n`,
    );
  } else {
    const id = newSessionId();
    session = createSession(root, id, store.open(id));
    session.journal?.write({ type: "start", sessionId: id, ...start });
    process.stderr.write(`Session ${id}\n`);
  }
  if (price === undefined) {
    process.stderr.write(
      `Garuda has no price for ${modelId}. Set model.price in .garuda/settings.json to see cost.\n`,
    );
  }
  addUserMessage(session, options.prompt);

  // First Ctrl-C stops the run and kills running commands. A second one exits at once.
  const controller = new AbortController();
  process.on("SIGINT", () => {
    if (controller.signal.aborted) process.exit(130);
    process.stderr.write("\nStopping… (press Ctrl-C again to exit at once)\n");
    controller.abort();
  });

  const costBefore = session.costUsd;
  try {
    const result = await runAgent(session, {
      model: new AnthropicClient({ model: modelId }),
      tools: new ToolRegistry(defaultTools()),
      system,
      permissions,
      executor,
      maxSteps: limits.maxSteps,
      tokenBudget: limits.tokenBudget,
      contextWindow: limits.contextWindow,
      ...(price === undefined ? {} : { price }),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "text_delta") process.stdout.write(event.text);
        if (event.type === "tool_call") {
          process.stderr.write(`\n→ ${event.call.name} ${JSON.stringify(event.call.input)}\n`);
        }
        if (event.type === "tool_result" && event.outcome.isError) {
          process.stderr.write(`  ✗ ${event.outcome.content.split("\n")[0]}\n`);
        }
        if (event.type === "compaction") {
          const { stage, beforeTokens, afterTokens } = event.result;
          process.stderr.write(
            `\n[context compacted (${stage}): ${formatTokens(beforeTokens)} → about ${formatTokens(afterTokens)} tokens]\n`,
          );
        }
      },
    });

    const runCost =
      costBefore === undefined || session.costUsd === undefined
        ? undefined
        : session.costUsd - costBefore;
    process.stderr.write(`\n[${usageLine(result, session, runCost, limits.contextWindow)}]\n`);
    const message = stopMessage(result.stopReason, limits);
    if (message !== undefined) {
      process.stderr.write(`${message}\n`);
      process.exitCode = 2;
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    session.journal?.write({ type: "end", stopReason: "interrupted", steps: 0 });
    process.stderr.write(`Stopped by the user. Use --resume to continue session ${session.id}.\n`);
    process.exitCode = 130;
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
