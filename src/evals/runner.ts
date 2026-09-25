import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, type RuntimeOptions } from "../app/runtime.js";
import type { CodeIndexMode } from "../knowledge/mode.js";
import type { AgentEvent } from "../loop/runAgent.js";
import { type ModelInfo, totalTokens } from "../model/pricing.js";
import type { ModelClient } from "../model/types.js";
import { AutoApprover } from "../permissions/autoApprover.js";
import { DEFAULT_ENV_ALLOWLIST } from "../permissions/engine.js";
import { parseSettings } from "../permissions/settings.js";
import { HostExecutor } from "../sandbox/host.js";
import type { ExecutorName } from "../sandbox/index.js";
import { FileSessionStore } from "../session/store.js";
import { writeFiles } from "./files.js";
import { isProtectedPath } from "./projects.js";
import { TOOLCHAIN_ENV } from "./toolchains.js";
import type { EvalResult, EvalTask } from "./types.js";

export { writeFiles };

/**
 * The eval runner (N5). Each task runs in a new scratch folder with its own session.
 * Approvals: the runner approves every call, except the deny rules below.
 * Commands run in the scratch folder, in the OS sandbox when this machine has one.
 */
export const EVAL_DENY_RULES = [
  "bash(rm -rf*)",
  "bash(sudo*)",
  "bash(git push*)",
  "bash(curl*)",
  "bash(wget*)",
];

/** A task that runs longer than this is stopped. */
export const EVAL_TASK_TIMEOUT_MS = 10 * 60_000;

export interface EvalOptions {
  modelId: string;
  /** Makes a model client for each task. */
  model: () => ModelClient | Promise<ModelClient>;
  /** Context window and price. Default: Garuda's table of Claude models. */
  modelInfo?: ModelInfo;
  maxTokens?: number;
  /** Session files are copied here, as <task-id>.jsonl. */
  outDir?: string;
  maxSteps?: number;
  /** Keep the scratch folders, to look at them after the run. */
  keep?: boolean;
  onEvent?: (taskId: string, event: AgentEvent) => void;
  /** Code index tools for the model. Default: the product default ("off"). */
  codeIndex?: CodeIndexMode;
  /** Default: "auto", the OS sandbox when this machine has one. */
  executor?: ExecutorName;
  /** The explore subagent (0.3). Default: off, as in the product. */
  subagents?: boolean;
  /** The todo_write tool (0.4). Default: off, as in the product. */
  todo?: boolean;
  /** The explore subagent's model. Default: the main model. */
  subagentModel?: RuntimeOptions["subagentModel"];
}

export async function runEvalTask(task: EvalTask, options: EvalOptions): Promise<EvalResult> {
  const started = Date.now();
  const root = realpathSync(await mkdtemp(join(tmpdir(), `garuda-eval-${task.id}-`)));
  await writeFiles(root, task.files);
  const protect = task.protect ?? Object.keys(task.files).filter(isProtectedPath);
  const before = await snapshot(root, protect);

  const settings = parseSettings({
    permissions: { deny: EVAL_DENY_RULES },
    // Evals must not depend on the internet.
    web: { enabled: false },
    ...(options.executor === undefined ? {} : { executor: options.executor }),
    ...(options.codeIndex === undefined ? {} : { codeIndex: options.codeIndex }),
    ...(options.maxSteps === undefined ? {} : { limits: { maxSteps: options.maxSteps } }),
    ...(options.subagents === undefined ? {} : { subagents: { enabled: options.subagents } }),
    ...(options.todo === undefined ? {} : { todo: { enabled: options.todo } }),
  });
  const store = new FileSessionStore(root);
  const runtime = await Runtime.create({
    root,
    modelId: options.modelId,
    model: async () => options.model(),
    ...(options.modelInfo === undefined ? {} : { modelInfo: options.modelInfo }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.subagentModel === undefined ? {} : { subagentModel: options.subagentModel }),
    approver: new AutoApprover("once"),
    store,
    settings,
    // The user's own MCP servers must not change eval results.
    mcp: false,
    hooks: false,
    commands: false,
    ...(options.onEvent === undefined
      ? {}
      : { onEvent: (event: AgentEvent) => options.onEvent?.(task.id, event) }),
  });

  const result: EvalResult = {
    id: task.id,
    title: task.title,
    passed: false,
    stopReason: "error",
    steps: 0,
    tokens: 0,
    costUsd: undefined,
    durationMs: 0,
  };

  const timeout = AbortSignal.timeout(EVAL_TASK_TIMEOUT_MS);
  try {
    const run = await runtime.runTurn(task.prompt, timeout);
    result.stopReason = run.stopReason;
    result.steps = run.steps;
  } catch (error) {
    runtime.recordStop("error");
    if (timeout.aborted) {
      // Too slow is the agent's failure, not an error of the run.
      result.stopReason = "timeout";
      result.reason = `The task took longer than ${EVAL_TASK_TIMEOUT_MS / 60_000} minutes.`;
    } else {
      result.reason = `The run failed: ${(error as Error).message}`;
    }
  } finally {
    runtime.executor.shutdown();
  }

  const session = runtime.session;
  if (session !== undefined) {
    result.tokens = totalTokens(session.usage);
    result.costUsd = session.costUsd;
    if (options.outDir !== undefined) {
      mkdirSync(options.outDir, { recursive: true });
      // With --repeat, later runs of a task get -2, -3, … in the file name.
      let target = join(options.outDir, `${task.id}.jsonl`);
      for (let n = 2; existsSync(target); n++)
        target = join(options.outDir, `${task.id}-${n}.jsonl`);
      await copyFile(store.path(session.id), target);
      result.sessionFile = target;
    }
  }

  if (result.reason === undefined) {
    const changed = await changedFiles(root, before);
    const check = await runCheck(root, task.check);
    if (changed.length > 0)
      result.reason = `The agent changed protected files: ${changed.join(", ")}.`;
    else if (!check.ok) result.reason = `The check failed:\n${check.output}`;
    else result.passed = true;
  }

  result.durationMs = Date.now() - started;
  if (!options.keep) await rm(root, { recursive: true, force: true });
  return result;
}

export async function runEvals(
  tasks: readonly EvalTask[],
  options: EvalOptions,
  onResult?: (result: EvalResult) => void,
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const task of tasks) {
    const result = await runEvalTask(task, options);
    results.push(result);
    onResult?.(result);
  }
  return results;
}

/** Run a task's check in a folder. Exported for the task self-tests. */
export async function runCheck(
  root: string,
  command: string,
): Promise<{ ok: boolean; output: string }> {
  const r = await new HostExecutor().run(command, {
    root,
    sandbox: false,
    writePaths: [root],
    denyWritePaths: [],
    denyReadPaths: [],
    network: false,
    envAllowlist: [...DEFAULT_ENV_ALLOWLIST, ...TOOLCHAIN_ENV],
    timeoutMs: 120_000,
    maxOutputBytes: 4_000,
  });
  const output = `${r.stdout.text}${r.stderr.text}`.trim();
  return { ok: r.exitCode === 0 && !r.timedOut, output };
}

async function snapshot(root: string, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of paths) out.set(path, await readFile(join(root, path), "utf8").catch(() => ""));
  return out;
}

async function changedFiles(root: string, before: Map<string, string>): Promise<string[]> {
  const after = await snapshot(root, [...before.keys()]);
  return [...before.keys()].filter((path) => before.get(path) !== after.get(path));
}

/** A table for the terminal, and the totals line. */
/**
 * A run that failed with an error (for example a broken connection to the API, after the retries)
 * says nothing about the agent: the pass count and the means leave it out, and the totals say how
 * many there were. Its tokens and cost still count in the totals: they were spent.
 */
export function isErrorRun(result: EvalResult): boolean {
  return result.stopReason === "error";
}

export function formatReport(results: readonly EvalResult[]): string {
  const rows = results.map((r) =>
    [
      r.passed ? "PASS" : isErrorRun(r) ? "ERR " : "FAIL",
      r.id.padEnd(18),
      `${String(r.steps).padStart(3)} steps`,
      `${(r.tokens / 1000).toFixed(1).padStart(7)}k tok`,
      r.costUsd === undefined ? "   cost ?" : `$${r.costUsd.toFixed(4).padStart(7)}`,
      `${(r.durationMs / 1000).toFixed(0).padStart(4)} s`,
      r.stopReason,
    ].join("  "),
  );
  const passed = results.filter((r) => r.passed).length;
  const errors = results.filter(isErrorRun).length;
  const cost = results.every((r) => r.costUsd !== undefined)
    ? `$${results.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(4)}`
    : "unknown";
  const steps = results.reduce((s, r) => s + r.steps, 0);
  const counted = `${passed}/${results.length - errors} passed${errors > 0 ? ` · ${errors} error run(s) not counted` : ""}`;
  const lines = [...rows, "", `${counted} · ${steps} steps · cost ${cost}`];
  const ids = [...new Set(results.map((r) => r.id))];
  // With --repeat, one run says little: show the mean per task.
  if (ids.length < results.length) lines.push("", "Mean per task:", ...meanRows(results, ids));
  return lines.join("\n");
}

function meanRows(results: readonly EvalResult[], ids: readonly string[]): string[] {
  return ids.map((id) => {
    const all = results.filter((r) => r.id === id);
    const runs = all.filter((r) => !isErrorRun(r));
    const errors = all.length - runs.length;
    const note = errors > 0 ? `  (${errors} error run(s) left out)` : "";
    if (runs.length === 0) return `${"0/0".padEnd(4)}  ${id.padEnd(18)}${note}`;
    const mean = (f: (r: EvalResult) => number) => runs.reduce((s, r) => s + f(r), 0) / runs.length;
    const passes = runs.filter((r) => r.passed).length;
    return (
      [
        `${passes}/${runs.length}`.padEnd(4),
        id.padEnd(18),
        `${mean((r) => r.steps)
          .toFixed(1)
          .padStart(5)} steps`,
        `${(mean((r) => r.tokens) / 1000).toFixed(1).padStart(7)}k tok`,
        runs.every((r) => r.costUsd !== undefined)
          ? `$${mean((r) => r.costUsd ?? 0)
              .toFixed(4)
              .padStart(7)}`
          : "   cost ?",
      ].join("  ") + note
    );
  });
}
