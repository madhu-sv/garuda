import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatReport, runEvals } from "../evals/runner.js";
import { ALL_TASKS, EVAL_SUITES, requiredToolchains } from "../evals/suites.js";
import { checkToolchains, prepareToolchain, TOOLCHAINS, toolchainId } from "../evals/toolchains.js";
import {
  CODE_INDEX_MODES,
  type CodeIndexMode,
  DEFAULT_CODE_INDEX_MODE,
} from "../knowledge/mode.js";
import { batchPrice } from "../model/pricing.js";
import { loadModelsConfig, type ResolvedModel, resolveModel } from "../model/providers.js";
import { createExecutor, EXECUTOR_NAMES, type ExecutorName } from "../sandbox/index.js";
import { newSessionId } from "../session/store.js";

export interface EvalCommandOptions {
  model?: string;
  task?: string[];
  maxSteps?: number;
  keep?: boolean;
  list?: boolean;
  suite?: string;
  repeat?: number;
  /** --index off|lookup|all. */
  index?: string;
  /** --executor auto|os|host. */
  executor?: ExecutorName;
  /** --prepare java|python: fill the toolchain's caches (network), then exit. */
  prepare?: string;
  /** --subagents on|off: the explore subagent (0.3). */
  subagents?: string;
  /** --subagent-model <spec>. */
  subagentModel?: string;
  /** --todo on|off: the todo_write tool (0.4). */
  todo?: string;
  /** --lsp on|off: language server errors in edit results (0.4). */
  lsp?: string;
  /** --batch on|off: model calls through the Batch API (0.7, Anthropic only). */
  batch?: string;
  /** --parallel <n>: tasks at the same time. Default 1; with --batch on, all tasks (up to 20). */
  parallel?: number;
}

/** A batch step can wait up to 24 hours; a whole task gets 12 hours with --batch on. */
export const BATCH_TASK_TIMEOUT_MS = 12 * 60 * 60_000;

/** `garuda eval` (N5). Results go to .garuda/evals/<run-id>/ in the current folder. */
export async function runEvalCommand(options: EvalCommandOptions): Promise<number> {
  if (options.list) {
    for (const [suite, tasks] of Object.entries(EVAL_SUITES)) {
      const needs = requiredToolchains(tasks).map((id) => TOOLCHAINS[id].title);
      process.stdout.write(`${suite}:${needs.length > 0 ? ` (needs ${needs.join(", ")})` : ""}\n`);
      for (const task of tasks) process.stdout.write(`  ${task.id.padEnd(18)} ${task.title}\n`);
    }
    return 0;
  }
  if (options.prepare !== undefined) return prepare(options.prepare);
  const modelId = options.model;
  if (!modelId) {
    process.stderr.write("Set a model with --model <id> or the GARUDA_MODEL variable.\n");
    return 1;
  }
  const models = await loadModelsConfig();
  if (models.problem !== undefined) {
    process.stderr.write(`${models.problem}\n`);
    return 1;
  }
  let resolved: ResolvedModel;
  try {
    resolved = resolveModel(modelId, models.config);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  for (const note of resolved.notes) process.stderr.write(`${note}\n`);
  const index = (options.index ?? DEFAULT_CODE_INDEX_MODE) as CodeIndexMode;
  if (!CODE_INDEX_MODES.includes(index)) {
    process.stderr.write(
      `Unknown index mode ${options.index}. Use: ${CODE_INDEX_MODES.join(", ")}.\n`,
    );
    return 1;
  }
  if (options.executor !== undefined && !EXECUTOR_NAMES.includes(options.executor)) {
    process.stderr.write(
      `Unknown executor ${options.executor}. Use: ${EXECUTOR_NAMES.join(", ")}.\n`,
    );
    return 1;
  }
  const subagentsMode = options.subagents ?? "off";
  if (subagentsMode !== "on" && subagentsMode !== "off") {
    process.stderr.write(`Unknown subagents mode ${options.subagents}. Use: on, off.\n`);
    return 1;
  }
  const todoMode = options.todo ?? "off";
  if (todoMode !== "on" && todoMode !== "off") {
    process.stderr.write(`Unknown todo mode ${options.todo}. Use: on, off.\n`);
    return 1;
  }
  const lspMode = options.lsp ?? "off";
  if (lspMode !== "on" && lspMode !== "off") {
    process.stderr.write(`Unknown lsp mode ${options.lsp}. Use: on, off.\n`);
    return 1;
  }
  const batchMode = options.batch ?? "off";
  if (batchMode !== "on" && batchMode !== "off") {
    process.stderr.write(`Unknown batch mode ${options.batch}. Use: on, off.\n`);
    return 1;
  }
  const createBatch = resolved.createBatch;
  if (batchMode === "on" && createBatch === undefined) {
    process.stderr.write(`--batch on needs an Anthropic model; ${resolved.spec} is not one.\n`);
    return 1;
  }
  let sub: ResolvedModel | undefined;
  if (options.subagentModel) {
    try {
      sub = resolveModel(options.subagentModel, models.config);
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      return 1;
    }
  }
  const suite = options.suite ?? "basic";
  const suiteTasks = suite === "all" ? ALL_TASKS : EVAL_SUITES[suite];
  if (suiteTasks === undefined) {
    process.stderr.write(
      `Unknown suite ${suite}. Use: ${[...Object.keys(EVAL_SUITES), "all"].join(", ")}.\n`,
    );
    return 1;
  }
  const chosen =
    options.task === undefined ? suiteTasks : ALL_TASKS.filter((t) => options.task?.includes(t.id));
  const repeat = Math.max(1, options.repeat ?? 1);
  // Each task runs `repeat` times in a row, in a new scratch folder each time.
  const tasks = chosen.flatMap((t) => Array.from({ length: repeat }, () => t));
  if (chosen.length === 0) {
    process.stderr.write("No task matches. Use --list to see the task ids.\n");
    return 1;
  }
  // Check the toolchains first: a missing one would fail every task and waste model calls.
  const missing = (await checkToolchains(requiredToolchains(chosen))).filter((s) => !s.ok);
  if (missing.length > 0) {
    for (const status of missing) {
      // The first lines name the problem (for Maven: the missing artifact).
      const detail = status.output
        .split("\n")
        .filter((line) => line.trim() !== "")
        .slice(0, 2)
        .join("\n    ");
      process.stderr.write(
        `${TOOLCHAINS[status.id].hint}\n${detail === "" ? "" : `    ${detail}\n`}`,
      );
    }
    return 1;
  }

  const { executor, notice } = createExecutor(options.executor ?? "auto");
  if (notice !== undefined) process.stderr.write(`${notice}\n`);
  if (lspMode === "on") {
    // An A/B run with no server would compare nothing: check before any model call.
    if (executor.isolation === "none") {
      process.stderr.write("--lsp on needs the OS sandbox: language servers run only there.\n");
      return 1;
    }
    const { discoverServer, LSP_LANGUAGES } = await import("../lsp/servers.js");
    const found = LSP_LANGUAGES.map((l) => ({ l, s: discoverServer(l, { root: process.cwd() }) }));
    if (found.every((f) => f.s === undefined)) {
      process.stderr.write(
        "--lsp on: no language server found. Run: garuda lsp install typescript\n",
      );
      return 1;
    }
    for (const { l, s } of found) {
      process.stderr.write(
        `LSP ${l}: ${s === undefined ? "none" : `${s.spec.name} (${s.path})`}\n`,
      );
    }
  }
  const where =
    executor.isolation === "none"
      ? "commands run on this machine with no sandbox"
      : `commands run in the ${executor.name} sandbox`;
  const parallel = Math.max(
    1,
    options.parallel ?? (batchMode === "on" ? Math.min(tasks.length, 20) : 1),
  );
  const outDir = join(process.cwd(), ".garuda", "evals", newSessionId());
  mkdirSync(outDir, { recursive: true });
  process.stderr.write(
    `Running ${chosen.length} task(s)${repeat > 1 ? ` × ${repeat}` : ""} (suite ${options.task === undefined ? suite : "custom"}, code index ${index}, subagents ${subagentsMode}${sub === undefined ? "" : ` on ${sub.spec}`}, todo ${todoMode}, lsp ${lspMode}, batch ${batchMode}${parallel > 1 ? `, ${parallel} at a time` : ""}) with ${modelId}. Garuda approves every call except its deny rules;\n${where}, in scratch folders.\n\n`,
  );

  if (batchMode === "on") {
    process.stderr.write(
      "Batch API: each model call waits for its batch (minutes, sometimes more) at half the token price.\n\n",
    );
  }
  const started = Date.now();
  const batchInfo =
    resolved.info.price === undefined
      ? resolved.info
      : { ...resolved.info, price: batchPrice(resolved.info.price) };
  const results = await runEvals(
    tasks,
    {
      modelId: resolved.spec,
      model: () =>
        batchMode === "on" && createBatch !== undefined ? createBatch() : resolved.create(),
      modelInfo: batchMode === "on" ? batchInfo : resolved.info,
      parallel,
      ...(batchMode === "on" ? { taskTimeoutMs: BATCH_TASK_TIMEOUT_MS } : {}),
      ...(resolved.maxTokens === undefined ? {} : { maxTokens: resolved.maxTokens }),
      outDir,
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      codeIndex: index,
      subagents: subagentsMode === "on",
      todo: todoMode === "on",
      lsp: lspMode === "on",
      ...(sub === undefined
        ? {}
        : { subagentModel: { spec: sub.spec, model: () => sub.create(), info: sub.info } }),
      executor: executor.name === "host" ? "host" : "os",
      ...(options.keep ? { keep: true } : {}),
      onEvent: (taskId, event) => {
        if (event.type === "tool_call") process.stderr.write(`  [${taskId}] ${event.call.name}\n`);
        if (event.type === "model_retry")
          process.stderr.write(
            `  [${taskId}] retry ${event.attempt}/${event.maxRetries}: ${event.reason}\n`,
          );
      },
    },
    (r) =>
      process.stderr.write(
        `${r.passed ? "✓" : "✗"} ${r.id}: ${r.passed ? "pass" : "fail"} (${r.steps} steps)${r.reason ? `\n    ${r.reason.split("\n").slice(0, 3).join("\n    ")}` : ""}\n`,
      ),
  );

  const wallMs = Date.now() - started;
  const report = `${formatReport(results)}\nWall time: ${Math.round(wallMs / 1000)} s${parallel > 1 ? ` (${parallel} tasks at a time)` : ""}.`;
  writeFileSync(
    join(outDir, "report.json"),
    `${JSON.stringify({ model: modelId, suite, repeat, codeIndex: index, subagents: subagentsMode, subagentModel: sub?.spec, todo: todoMode, lsp: lspMode, batch: batchMode, parallel, wallMs, executor: executor.name, results }, null, 2)}\n`,
  );
  process.stdout.write(`\n${report}\n\nSession files and report.json: ${outDir}\n`);
  return results.every((r) => r.passed) ? 0 : 2;
}

/** `garuda eval --prepare java|python`. */
async function prepare(name: string): Promise<number> {
  const id = toolchainId(name);
  if (id === undefined) {
    process.stderr.write(`Unknown toolchain ${name}. Use: java, python.\n`);
    return 1;
  }
  const toolchain = TOOLCHAINS[id];
  if (toolchain.prepare !== undefined) {
    process.stderr.write(
      `Preparing ${toolchain.title}: running \`${toolchain.prepare}\` in a scratch project (downloads with network)…\n`,
    );
    const r = await prepareToolchain(id);
    if (!r.ok) {
      process.stderr.write(`It failed:\n${r.output}\n`);
      return 1;
    }
  }
  const [status] = await checkToolchains([id]);
  if (status?.ok) {
    process.stderr.write(`${toolchain.title}: ready.\n`);
    return 0;
  }
  process.stderr.write(`${toolchain.hint}\n${status?.output ?? ""}\n`);
  return 1;
}
