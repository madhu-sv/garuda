import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, type RuntimeOptions } from "../app/runtime.js";
import { git } from "../jobs/git.js";
import type { CodeIndexMode } from "../knowledge/mode.js";
import { DEFAULT_MAX_STEPS } from "../loop/limits.js";
import type { AgentEvent } from "../loop/runAgent.js";
import { type ModelInfo, totalTokens } from "../model/pricing.js";
import type { ModelClient } from "../model/types.js";
import { AutoApprover } from "../permissions/autoApprover.js";
import { DEFAULT_ENV_ALLOWLIST } from "../permissions/engine.js";
import type { TeamPolicy } from "../permissions/policy.js";
import { parseSettings } from "../permissions/settings.js";
import { HostExecutor } from "../sandbox/host.js";
import type { ExecutorName } from "../sandbox/index.js";
import type { ExecPolicy, Executor } from "../sandbox/types.js";
import { isCostIncomplete } from "../session/session.js";
import { FileSessionStore } from "../session/store.js";
import { type ClaudeCodeAgent, runClaudeCode } from "./agents/claudeCode.js";
import { changedPaths, treeState, unexpectedPaths } from "./changes.js";
import { roughNote } from "./compare.js";
import { writeFiles } from "./files.js";
import { isProtectedPath } from "./projects.js";
import { applyTests, removeTaskWorktree, taskWorktree } from "./repoTasks.js";
import {
  consistency,
  costPerPass,
  DEFAULT_SEED,
  passInterval,
  spread,
  stepsSd,
  unexpectedChanges,
} from "./stats.js";
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

/** The check of a repo task (0.12): the project's own tests. */
export const REPO_CHECK_TIMEOUT_MS = 5 * 60_000;

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
  /** Language server errors in edit results (0.4). Default: off, as in the product. */
  lsp?: boolean;
  /** Keep Claude's thinking blocks (0.9). Default: on, as in the product. */
  keepThinking?: boolean;
  /**
   * The formatter A/B (0.10). Both arms get a biome.json and the whole project formatted first,
   * so it starts in the formatter's style, as a project with a formatter does; `on` also formats
   * each file after an edit. `biome` is Biome's binary (Garuda's own dev dependency).
   */
  format?: { on: boolean; biome: string };
  /** The explore subagent's model. Default: the main model. */
  subagentModel?: RuntimeOptions["subagentModel"];
  /** Tasks that run at the same time (0.7). Default: 1. */
  parallel?: number;
  /** Time limit per task. Default: EVAL_TASK_TIMEOUT_MS (the Batch API needs much more). */
  taskTimeoutMs?: number;
  /** The team policy (merge gate): evals obey it as the chat does. Absent: none. */
  policy?: TeamPolicy;
  /**
   * The network allowlist (0.13): presets and hosts that sandboxed commands may reach through
   * Garuda's proxy. Other hosts are denied (no question). Default: none, as in the product.
   */
  network?: string[];
  /**
   * The agent (0.17, T11b): Garuda (default) or the Claude Code baseline. The baseline runs in
   * the run's executor with the same scratch folder, time limit and grading; the model, the
   * settings above that change Garuda, and the session belong to Garuda only.
   */
  agent?: ClaudeCodeAgent;
}

export async function runEvalTask(task: EvalTask, options: EvalOptions): Promise<EvalResult> {
  const started = Date.now();
  const host = new HostExecutor();
  let root: string;
  if (task.repo === undefined) {
    root = realpathSync(await mkdtemp(join(tmpdir(), `garuda-eval-${task.id}-`)));
    await writeFiles(root, task.files);
  } else {
    // Benchmark your repo (0.12): the project at the commit's parent, with its tests added.
    root = await taskWorktree(host, task.repo.root, task.repo.base);
    await applyTests(root, task.repo.tests);
  }
  if (options.format !== undefined) await formatProject(root, options.format.biome);
  const protect = task.protect ?? Object.keys(task.files).filter(isProtectedPath);
  const before = await snapshot(root, protect);
  // The start state for the changed files (0.17, T11a).
  const start = await treeState(root);

  const settings = parseSettings({
    // With an allowlist, a host outside it is denied: nobody answers questions in an eval.
    permissions: {
      deny: options.network === undefined ? EVAL_DENY_RULES : [...EVAL_DENY_RULES, "network"],
    },
    ...(options.network === undefined ? {} : { network: { allow: options.network } }),
    // Evals must not depend on the internet.
    web: { enabled: false },
    ...(options.executor === undefined ? {} : { executor: options.executor }),
    ...(options.codeIndex === undefined ? {} : { codeIndex: options.codeIndex }),
    ...(options.maxSteps === undefined ? {} : { limits: { maxSteps: options.maxSteps } }),
    ...(options.subagents === undefined ? {} : { subagents: { enabled: options.subagents } }),
    ...(options.todo === undefined ? {} : { todo: { enabled: options.todo } }),
    ...(options.format === undefined
      ? {}
      : {
          formatters: {
            enabled: options.format.on,
            commands: {
              biome: {
                extensions: ["js", "jsx", "mjs", "cjs", "ts", "tsx", "json"],
                command: [options.format.biome, "format", "--write", "$FILE"],
              },
            },
          },
        }),
    ...(options.keepThinking === undefined
      ? {}
      : { thinking: { keepBlocks: options.keepThinking } }),
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
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    commands: false,
    // The list comes from the eval command line: the user typed it.
    ...(options.network === undefined ? {} : { network: { approved: true } }),
    ...(options.lsp === undefined ? {} : { lsp: { enabled: options.lsp } }),
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

  const limitMs = options.taskTimeoutMs ?? EVAL_TASK_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(limitMs);
  try {
    if (options.agent !== undefined) {
      // The baseline (T11b): Claude Code in the run's sandbox, with the same limits. The proxy
      // for api.anthropic.com starts first (the user's first run: no proxy, ECONNREFUSED).
      await runtime.prepareCommands(timeout);
      const { result: exec, outcome } = await runClaudeCode(
        runtime.executor,
        runtime.execPolicy(limitMs),
        options.agent,
        task.prompt,
        options.maxSteps ?? DEFAULT_MAX_STEPS,
        timeout,
      );
      result.stopReason = outcome.stopReason;
      result.steps = outcome.steps;
      result.tokens = outcome.tokens;
      result.cacheReadTokens = outcome.cacheReadTokens;
      result.costUsd = outcome.costUsd;
      if (outcome.reason !== undefined) result.reason = outcome.reason;
      if (options.outDir !== undefined) {
        mkdirSync(options.outDir, { recursive: true });
        let target = join(options.outDir, `${task.id}.claude.json`);
        for (let n = 2; existsSync(target); n++)
          target = join(options.outDir, `${task.id}-${n}.claude.json`);
        await writeFile(target, exec.stdout.text);
        result.sessionFile = target;
      }
    } else {
      const run = await runtime.runTurn(task.prompt, timeout);
      result.stopReason = run.stopReason;
      result.steps = run.steps;
    }
  } catch (error) {
    runtime.recordStop("error");
    if (timeout.aborted) {
      // Too slow is the agent's failure, not an error of the run.
      result.stopReason = "timeout";
      result.reason = `The task took longer than ${limitMs / 60_000} minutes.`;
    } else {
      result.reason = `The run failed: ${(error as Error).message}`;
    }
  } finally {
    await runtime.close();
    runtime.executor.shutdown();
  }

  const session = runtime.session;
  if (session !== undefined && options.agent === undefined) {
    result.tokens = totalTokens(session.usage);
    if (session.unreportedTokens > 0) result.unreportedTokens = session.unreportedTokens;
    result.costUsd = session.costUsd;
    if (isCostIncomplete(session)) result.costIncomplete = true;
    result.cacheReadTokens = session.usage.cacheReadTokens;
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

  // What the run changed, before the check writes its own output (0.17, T11a).
  result.changed = changedPaths(start, await treeState(root));
  const expected = await expectedFiles(task, host);
  if (expected !== undefined) {
    result.unexpected = unexpectedPaths(result.changed, expected, task.allowChanges);
  }

  if (result.reason === undefined) {
    const changed = await changedFiles(root, before);
    // A project's own test suite can take longer than a small task's check.
    const checkMs = task.repo === undefined ? 120_000 : REPO_CHECK_TIMEOUT_MS;
    const check = await runCheck(
      root,
      task.check,
      checkMs,
      runtime.executor.isolation === "none"
        ? undefined
        : { executor: runtime.executor, policy: runtime.execPolicy(checkMs) },
    );
    if (changed.length > 0)
      result.reason = `The agent changed protected files: ${changed.join(", ")}.`;
    else if (!check.ok) result.reason = `The check failed:\n${check.output}`;
    else result.passed = true;
  }

  result.durationMs = Date.now() - started;
  if (!options.keep) {
    if (task.repo === undefined) await rm(root, { recursive: true, force: true });
    else await removeTaskWorktree(host, task.repo.root, root);
  }
  return result;
}

/**
 * The files that a task is expected to change: its solution files, or a repo task's commit
 * (without its tests, which the runner adds). Undefined when git cannot list the commit.
 */
async function expectedFiles(task: EvalTask, host: HostExecutor): Promise<string[] | undefined> {
  if (task.repo === undefined) return Object.keys(task.solution);
  if (task.repo.sha === undefined) return undefined;
  const r = await git(
    host,
    task.repo.root,
    ["diff", "--name-only", task.repo.base, task.repo.sha],
    {
      check: false,
    },
  );
  if (r.exitCode !== 0) return undefined;
  const tests = new Set(task.repo.tests.map((t) => t.path));
  return r.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !tests.has(line));
}

/**
 * The provider refused the key or the access (401 or 403): every later run fails the same way,
 * so the eval stops instead of spending the time of the other runs.
 */
export function isAuthFailure(result: EvalResult): boolean {
  if (!isErrorRun(result) || result.reason === undefined) return false;
  return /\b40[13]\b|authentication_error|permission_error|invalid x-api-key|invalid api key/i.test(
    result.reason,
  );
}

/**
 * The API cannot be reached at all (0.17): a refused connection, an unknown host, a certificate
 * error. The user's first baseline run retried this for 200 s in each of six runs.
 */
export function isConnectionFailure(result: EvalResult): boolean {
  if (!isErrorRun(result) || result.reason === undefined) return false;
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|connection refused|self[- ]signed certificate|unable to get local issuer certificate|certificate has expired/i.test(
    result.reason,
  );
}

/** A failure that every later run would repeat: the eval stops at it (0.17). */
export function isSetupFailure(result: EvalResult): boolean {
  return isAuthFailure(result) || isConnectionFailure(result);
}

/**
 * Run the tasks, `parallel` at a time; the results keep the task order. `stop` (0.17): when it
 * returns true for a result, no further task starts, and the result list holds the runs that ran.
 */
export async function runEvals(
  tasks: readonly EvalTask[],
  options: EvalOptions,
  onResult?: (result: EvalResult) => void,
  stop?: (result: EvalResult) => boolean,
): Promise<EvalResult[]> {
  // A small pool: `parallel` tasks at a time; the results keep the task order.
  const results: EvalResult[] = new Array(tasks.length);
  // The repeats of one task are numbered in the order of the list (0.17, T11a).
  const seen = new Map<string, number>();
  const attempts = tasks.map((t) => {
    const n = (seen.get(t.id) ?? 0) + 1;
    seen.set(t.id, n);
    return n;
  });
  let next = 0;
  let stopped = false;
  const worker = async () => {
    for (let i = next++; i < tasks.length && !stopped; i = next++) {
      const result = await runEvalTask(tasks[i] as EvalTask, options);
      result.attempt = attempts[i] as number;
      results[i] = result;
      onResult?.(result);
      if (stop?.(result)) stopped = true;
    }
  };
  const width = Math.max(1, Math.min(options.parallel ?? 1, tasks.length));
  await Promise.all(Array.from({ length: width }, worker));
  return results.filter((r) => r !== undefined);
}

/**
 * Run a task's check in a folder. Exported for the task self-tests, which run known solutions on
 * the host. After an agent's turn, the check runs code that the agent wrote, so `sandboxed` gives
 * the run's OS sandbox and its policy (0.14.1, review: the check ran on the host).
 */
export async function runCheck(
  root: string,
  command: string,
  timeoutMs = 120_000,
  sandboxed?: { executor: Executor; policy: ExecPolicy },
): Promise<{ ok: boolean; output: string }> {
  const envAllowlist = [...DEFAULT_ENV_ALLOWLIST, ...TOOLCHAIN_ENV];
  const r =
    sandboxed === undefined
      ? await new HostExecutor().run(command, {
          root,
          sandbox: false,
          writePaths: [root],
          denyWritePaths: [],
          denyReadPaths: [],
          network: false,
          envAllowlist,
          timeoutMs,
          maxOutputBytes: 4_000,
        })
      : await sandboxed.executor.run(command, {
          ...sandboxed.policy,
          envAllowlist: [...new Set([...sandboxed.policy.envAllowlist, ...TOOLCHAIN_ENV])],
          timeoutMs,
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

/**
 * Pass counts over two denominators (review of 0.16.1): the scored runs (error runs left out, so
 * the rate says how the agent does when the run completes) and all attempted runs (error runs count
 * as failures, so the rate says how often a user gets a passing result).
 */
export interface EvalSummary {
  attempted: number;
  errors: number;
  scored: number;
  passed: number;
  /** passed / scored; undefined when no run was scored. */
  scoredRate?: number;
  /** passed / attempted; undefined when no run was attempted. */
  attemptedRate?: number;
}

export function summarize(results: readonly EvalResult[]): EvalSummary {
  const attempted = results.length;
  const errors = results.filter(isErrorRun).length;
  const scored = attempted - errors;
  const passed = results.filter((r) => r.passed).length;
  return {
    attempted,
    errors,
    scored,
    passed,
    ...(scored === 0 ? {} : { scoredRate: passed / scored }),
    ...(attempted === 0 ? {} : { attemptedRate: passed / attempted }),
  };
}

const percent = (rate: number | undefined) =>
  rate === undefined ? "–" : `${Math.round(rate * 100)}%`;

export function formatReport(
  results: readonly EvalResult[],
  options: { seed?: number } = {},
): string {
  const rows = results.map((r) =>
    [
      r.passed ? "PASS" : isErrorRun(r) ? "ERR " : "FAIL",
      r.id.padEnd(18),
      `${String(r.steps).padStart(3)} steps`,
      (r.unreportedTokens ?? 0) > 0
        ? `tok ? (${r.unreportedTokens} reserved)`
        : `${(r.tokens / 1000).toFixed(1).padStart(7)}k tok`,
      r.costUsd === undefined
        ? "   cost ?"
        : `${r.costIncomplete === true ? "≥" : ""}$${r.costUsd.toFixed(4).padStart(7)}`,
      `${(r.durationMs / 1000).toFixed(0).padStart(4)} s`,
      r.stopReason,
    ].join("  "),
  );
  const summary = summarize(results);
  // A run with an incomplete cost gives a minimum, not "unknown" (review of 1370184).
  const known = `$${results.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(4)}`;
  const cost = !results.every((r) => r.costUsd !== undefined)
    ? "unknown"
    : results.some((r) => r.costIncomplete === true)
      ? `≥ ${known} (incomplete)`
      : known;
  const steps = results.reduce((s, r) => s + r.steps, 0);
  const counted =
    `${summary.passed}/${summary.scored} scored runs passed (${percent(summary.scoredRate)})` +
    ` · ${summary.passed}/${summary.attempted} of all attempted runs (${percent(summary.attemptedRate)})` +
    (summary.errors > 0 ? ` · ${summary.errors} error run(s)` : "");
  const tokens = results.reduce((s, r) => s + r.tokens, 0);
  const cached = results.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0);
  const share = results.some((r) => (r.unreportedTokens ?? 0) > 0)
    ? " · cache share unknown"
    : tokens === 0
      ? ""
      : ` · ${Math.round((cached / tokens) * 100)}% of tokens from the cache`;
  const lines = [
    ...rows,
    "",
    `${counted} · ${steps} steps · cost ${cost}${share}`,
    ...evidenceLines(results, options.seed ?? DEFAULT_SEED),
  ];
  const ids = [...new Set(results.map((r) => r.id))];
  // With --repeat, one run says little: show the mean per task.
  if (ids.length < results.length) lines.push("", "Mean per task:", ...meanRows(results, ids));
  return lines.join("\n");
}

/** The evidence lines (0.17, T11a): interval, consistency, spread, cost per pass, unexpected. */
function evidenceLines(results: readonly EvalResult[], seed: number): string[] {
  const out: string[] = [];
  // No run completed: the numbers below would describe the errors, not the agent.
  if (results.length > 0 && results.every(isErrorRun)) {
    return [
      "No scored run: every run failed with an error (the reasons are above), so this run gives no evidence about the agent.",
    ];
  }
  const interval = passInterval(results, { seed });
  if (interval !== undefined && interval.tasks >= 2) {
    out.push(
      `Pass rate over all attempts: ${percent(interval.rate)} (95% interval ${percent(interval.low)}–${percent(interval.high)}; cluster bootstrap over ${interval.tasks} tasks, ${interval.draws} draws, seed ${interval.seed})`,
    );
    // The user's first live run: 2 tasks, every run passed, "100%–100%" (correct, but no evidence).
    if (interval.low === interval.high) {
      out.push(
        "  Every draw gave the same rate, so the interval shows no uncertainty: more tasks are needed to measure it.",
      );
    }
    if (interval.tasks < 10) out.push(`  ${roughNote(interval.tasks)}`);
  }
  const c = consistency(results);
  if (c.repeated > 0) {
    const none = c.nonePassed.length === 0 ? "" : ` (${c.nonePassed.join(", ")})`;
    const errors =
      c.onlyErrors.length === 0
        ? ""
        : `; ${c.onlyErrors.length} had only error runs (${c.onlyErrors.join(", ")})`;
    out.push(
      `Consistency: ${c.allPassed.length} of ${c.repeated} repeated tasks passed every run; ${c.nonePassed.length} passed none${none}${errors}`,
    );
  }
  const s = spread(results);
  if (s !== undefined) {
    const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
    const sec = (ms: number) => `${Math.round(ms / 1000)} s`;
    out.push(
      `Spread (${s.runs} scored runs): steps median ${s.steps.median.toFixed(1)}, p95 ${s.steps.p95.toFixed(1)} · tokens median ${k(s.tokens.median)}, p95 ${k(s.tokens.p95)} · time median ${sec(s.durationMs.median)}, p95 ${sec(s.durationMs.p95)}`,
    );
  }
  const cost = costPerPass(results);
  out.push(
    cost.kind === "unknown"
      ? "Cost per accepted change: unknown (a run's cost is unknown)"
      : cost.kind === "none"
        ? "Cost per accepted change: no passes"
        : `Cost per accepted change: ${cost.minimum ? "≥ " : ""}$${cost.usd.toFixed(4)} (all attempts ${cost.minimum ? "≥ " : ""}$${cost.totalUsd.toFixed(4)} / ${cost.passes} pass${cost.passes === 1 ? "" : "es"})`,
  );
  const u = unexpectedChanges(results);
  if (u.measured > 0) {
    out.push(
      `Unexpected changes: ${u.runs} of ${u.measured} runs, ${u.files} file${u.files === 1 ? "" : "s"}`,
    );
    const shown = results.filter((r) => (r.unexpected?.length ?? 0) > 0).slice(0, 5);
    for (const r of shown) {
      out.push(
        `  ${r.id}${r.attempt === undefined ? "" : ` (run ${r.attempt})`}: ${(r.unexpected ?? []).join(", ")}`,
      );
    }
    if (u.runs > shown.length) out.push(`  … ${u.runs - shown.length} more in report.json`);
  }
  return out;
}

function meanRows(results: readonly EvalResult[], ids: readonly string[]): string[] {
  return ids.map((id) => {
    const all = results.filter((r) => r.id === id);
    const runs = all.filter((r) => !isErrorRun(r));
    const errors = all.length - runs.length;
    const passesAll = all.filter((r) => r.passed).length;
    const note =
      errors > 0 ? `  (${passesAll}/${all.length} of all attempts; ${errors} error run(s))` : "";
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
        runs.some((r) => (r.unreportedTokens ?? 0) > 0)
          ? "    tok ?"
          : `${(mean((r) => r.tokens) / 1000).toFixed(1).padStart(7)}k tok`,
        runs.every((r) => r.costUsd !== undefined)
          ? `${runs.some((r) => r.costIncomplete === true) ? "≥" : ""}$${mean((r) => r.costUsd ?? 0)
              .toFixed(4)
              .padStart(7)}`
          : "   cost ?",
        ...(stepsSd(runs) === undefined
          ? []
          : [`sd ${(stepsSd(runs) as number).toFixed(1)} steps`]),
      ].join("  ") + note
    );
  });
}

/** The formatter A/B's project config (0.10): spaces, width 100, formatting only. */
export const EVAL_BIOME_CONFIG = {
  formatter: { indentStyle: "space", indentWidth: 2, lineWidth: 100 },
  linter: { enabled: false },
  assist: { enabled: false },
};

/** Write biome.json and format the whole scratch project once, before the run (0.10). */
export async function formatProject(root: string, biome: string): Promise<void> {
  await writeFile(join(root, "biome.json"), `${JSON.stringify(EVAL_BIOME_CONFIG, null, 2)}\n`);
  const result = await new HostExecutor().run(`${shellWord(biome)} format --write .`, {
    root,
    sandbox: false,
    writePaths: [root],
    denyWritePaths: [],
    denyReadPaths: [],
    network: false,
    envAllowlist: [...DEFAULT_ENV_ALLOWLIST],
    timeoutMs: 60_000,
    maxOutputBytes: 20_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Biome could not format the eval project: ${result.stderr.text.trim().split("\n")[0] ?? ""}`,
    );
  }
}

function shellWord(text: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}
