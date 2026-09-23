import { mkdirSync, realpathSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Runtime } from "../app/runtime.js";
import type { AgentEvent } from "../loop/runAgent.js";
import { totalTokens } from "../model/pricing.js";
import type { ModelClient } from "../model/types.js";
import { AutoApprover } from "../permissions/autoApprover.js";
import { DEFAULT_ENV_ALLOWLIST } from "../permissions/engine.js";
import { parseSettings } from "../permissions/settings.js";
import { HostExecutor } from "../sandbox/host.js";
import { FileSessionStore } from "../session/store.js";
import type { EvalResult, EvalTask } from "./types.js";

/**
 * The eval runner (N5). Each task runs in a new scratch folder with its own session.
 * Approvals: the runner approves every call, except the deny rules below.
 * Commands run on this machine, in the scratch folder, with no sandbox (0.1).
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
  /** Session files are copied here, as <task-id>.jsonl. */
  outDir?: string;
  maxSteps?: number;
  /** Keep the scratch folders, to look at them after the run. */
  keep?: boolean;
  onEvent?: (taskId: string, event: AgentEvent) => void;
}

export async function runEvalTask(task: EvalTask, options: EvalOptions): Promise<EvalResult> {
  const started = Date.now();
  const root = realpathSync(await mkdtemp(join(tmpdir(), `garuda-eval-${task.id}-`)));
  await writeFiles(root, task.files);
  const protect = task.protect ?? Object.keys(task.files).filter((p) => p.startsWith("test/"));
  const before = await snapshot(root, protect);

  const settings = parseSettings({
    permissions: { deny: EVAL_DENY_RULES },
    ...(options.maxSteps === undefined ? {} : { limits: { maxSteps: options.maxSteps } }),
  });
  const store = new FileSessionStore(root);
  const runtime = await Runtime.create({
    root,
    modelId: options.modelId,
    model: async () => options.model(),
    approver: new AutoApprover("once"),
    store,
    settings,
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

  try {
    const run = await runtime.runTurn(task.prompt, AbortSignal.timeout(EVAL_TASK_TIMEOUT_MS));
    result.stopReason = run.stopReason;
    result.steps = run.steps;
  } catch (error) {
    runtime.recordStop("error");
    result.reason = `The run failed: ${(error as Error).message}`;
  } finally {
    runtime.executor.shutdown();
  }

  const session = runtime.session;
  if (session !== undefined) {
    result.tokens = totalTokens(session.usage);
    result.costUsd = session.costUsd;
    if (options.outDir !== undefined) {
      mkdirSync(options.outDir, { recursive: true });
      const target = join(options.outDir, `${task.id}.jsonl`);
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
    readPaths: [root],
    writePaths: [root],
    network: false,
    envAllowlist: [...DEFAULT_ENV_ALLOWLIST],
    timeoutMs: 120_000,
    maxOutputBytes: 4_000,
  });
  const output = `${r.stdout.text}${r.stderr.text}`.trim();
  return { ok: r.exitCode === 0 && !r.timedOut, output };
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
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
export function formatReport(results: readonly EvalResult[]): string {
  const rows = results.map((r) =>
    [
      r.passed ? "PASS" : "FAIL",
      r.id.padEnd(18),
      `${String(r.steps).padStart(3)} steps`,
      `${(r.tokens / 1000).toFixed(1).padStart(7)}k tok`,
      r.costUsd === undefined ? "   cost ?" : `$${r.costUsd.toFixed(4).padStart(7)}`,
      `${(r.durationMs / 1000).toFixed(0).padStart(4)} s`,
      r.stopReason,
    ].join("  "),
  );
  const passed = results.filter((r) => r.passed).length;
  const cost = results.every((r) => r.costUsd !== undefined)
    ? `$${results.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(4)}`
    : "unknown";
  const steps = results.reduce((s, r) => s + r.steps, 0);
  return [
    ...rows,
    "",
    `${passed}/${results.length} passed · ${steps} steps · cost ${cost} · 0.1 target: 7/10`,
  ].join("\n");
}
