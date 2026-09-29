import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "../app/runtime.js";
import { git as gitCommand, hostCommand, JobGitError } from "../jobs/git.js";
import { JOBS_DIR, type Job, type JobResult, loadJob, saveJob } from "../jobs/job.js";
import { type AgentEnv, defaultAgentEnv, removeAgent } from "../jobs/launchd.js";
import {
  jobVerdict,
  parseReview,
  reviewerSystem,
  reviewPrompt,
  riskFlags,
  stackOf,
  type TestRun,
  testSummary,
} from "../jobs/proof.js";
import { jobReport } from "../jobs/text.js";
import { cleanArgs, commitJob, jobChanges, prepareWorktree } from "../jobs/worktree.js";
import type { DeadlineClient } from "../model/deadline.js";
import { totalTokens } from "../model/pricing.js";
import { parseRule } from "../permissions/rules.js";
import { loadSettings, type Settings } from "../permissions/settings.js";
import { createExecutor } from "../sandbox/index.js";
import type { Executor } from "../sandbox/types.js";
import { notificationBytes, pickChannel } from "./notify.js";
import type { Renderer } from "./renderer.js";
import type { TurnOutcome } from "./turn.js";

/**
 * `garuda run <job> [--at HH:MM]` (0.7): run a scheduled job with nobody at the keyboard. The CLI
 * builds the runtime as for `-p`, in the job's worktree, with the job's approval list and an
 * engine that denies instead of asking; this module prepares the run and writes the result.
 */

export interface PreparedJob {
  job: Job;
  /** The worktree: the runtime's root. */
  root: string;
  settings: Settings;
  denied: { tool: string; target: string }[];
  startedAt: number;
  /** With the Batch API: the client that counts batch and normal requests (0.7). */
  deadline?: DeadlineClient;
  /** Proof of work (0.11): the tests at the job's base, before the turn. */
  testsBefore?: TestRun;
}

/** Most time for one test run of a job (0.11). */
export const JOB_TEST_TIMEOUT_MS = 10 * 60_000;

/**
 * Proof of work (0.11): run the job's tests at its base, before the turn, in the sandbox. The
 * worktree then goes back to the base (test output files must not reach the job's commit).
 */
export async function testsBefore(
  prepared: PreparedJob,
  runtime: Runtime,
  renderer: Renderer,
  git: Executor = createExecutor("host").executor,
): Promise<void> {
  const { job } = prepared;
  if (job.test === undefined) return;
  renderer.info(`Tests before the job: ${job.test}`);
  prepared.testsBefore = await runtime.runCheck(
    job.test,
    JOB_TEST_TIMEOUT_MS,
    new AbortController().signal,
  );
  renderer.info(`Tests before the job: ${testSummary(prepared.testsBefore)}`);
  await gitCommand(git, job.worktree, ["checkout", "--", "."], { check: false });
  // Keep the links (node_modules, venvs): a symlink is not a folder, so .gitignore's
  // "node_modules/" does not protect it from clean.
  await gitCommand(git, job.worktree, cleanArgs(job.links), { check: false });
}

/** After the commit (0.11): the tests again, the risk flags, the review and the verdict. */
async function proveJob(
  prepared: PreparedJob,
  result: JobResult,
  runtime: Runtime,
  renderer: Renderer,
  git: Executor,
): Promise<NonNullable<JobResult["proof"]>> {
  const { job } = prepared;
  const signal = new AbortController().signal;
  let after: TestRun | undefined;
  if (job.test !== undefined) {
    after = await runtime.runCheck(job.test, JOB_TEST_TIMEOUT_MS, signal);
    renderer.info(`Tests after the job: ${testSummary(after)}`);
  }
  const before = prepared.testsBefore;
  const flags = riskFlags({
    result,
    ...(job.test === undefined ? {} : { test: job.test }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  });
  if (result.commit === undefined) flags.push({ level: "look", text: "No file changed." });
  const proof: NonNullable<JobResult["proof"]> = {
    verdict: "needs-look",
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    flags,
  };
  if (job.review !== false && result.commit !== undefined) {
    renderer.info("Reviewing the diff (a principal engineer's review)…");
    try {
      const diff = (
        await gitCommand(git, job.root, ["diff", "--no-renames", job.base, job.branch], {
          check: false,
        })
      ).stdout;
      const answer = await runtime.askModel(
        reviewerSystem(stackOf(result.files, runtime.profiles)),
        reviewPrompt({
          prompt: job.prompt,
          files: result.files,
          ...(job.test === undefined ? {} : { test: job.test }),
          ...(before === undefined ? {} : { before }),
          ...(after === undefined ? {} : { after }),
          flags,
          diff,
        }),
        signal,
      );
      const parsed = parseReview(answer.text);
      proof.review = {
        ...parsed,
        ...(answer.costUsd === undefined ? {} : { costUsd: answer.costUsd }),
      };
    } catch (error) {
      proof.reviewError = (error as Error).message;
    }
  }
  proof.verdict = jobVerdict(flags, proof.review?.verdict);
  return proof;
}

/** Load the job, wait for --at, make its worktree, and build its settings. A number = exit code. */
export async function prepareJob(
  mainRoot: string,
  id: string,
  at: string | undefined,
  renderer: Renderer,
  git: Executor = createExecutor("host").executor,
  launchd: LaunchdRun = {},
): Promise<PreparedJob | number> {
  const prepared = await prepare(mainRoot, id, at, renderer, git);
  // A start from the agent that does not run (done, running, broken): the agent goes anyway.
  if (typeof prepared === "number" && launchd.fromLaunchd === true) {
    const job = await loadJob(mainRoot, id).catch(() => undefined);
    if (job !== undefined) await removeAgent(git, job, launchd.env ?? defaultAgentEnv());
  }
  return prepared;
}

/** `garuda run --from-launchd` (0.7): the agent started this run; it removes the agent at the end. */
export interface LaunchdRun {
  fromLaunchd?: boolean;
  env?: AgentEnv;
}

async function prepare(
  mainRoot: string,
  id: string,
  at: string | undefined,
  renderer: Renderer,
  git: Executor,
): Promise<PreparedJob | number> {
  let job: Job;
  try {
    job = await loadJob(mainRoot, id);
  } catch (error) {
    renderer.error((error as Error).message);
    return 1;
  }
  if (job.status === "running") {
    renderer.error(
      `Job ${id} is marked as running. If no other garuda runs it, set "status" to "stopped" in ${JOBS_DIR}/${id}.json and try again.`,
    );
    return 1;
  }
  if (job.status === "done") {
    renderer.error(`Job ${id} is done. Its report: ${join(JOBS_DIR, `${id}.md`)}`);
    return 1;
  }
  if (at !== undefined) {
    const waited = await waitUntil(at, renderer, job);
    if (waited !== 0) return waited;
  }
  try {
    await prepareWorktree(git, job);
  } catch (error) {
    if (!(error instanceof JobGitError)) throw error;
    renderer.error(`The job's worktree failed: ${error.message}`);
    return 1;
  }
  const project = await loadSettings(job.worktree);
  const links = job.links.map((name) => join(job.root, name));
  const settings: Settings = {
    ...project,
    allow: [...project.allow, ...job.allow.map((rule) => parseRule(rule))],
    maxSteps: job.maxSteps,
    sandbox: {
      ...project.sandbox,
      // Linked folders (node_modules …) live in the checkout: tools may write their caches there.
      writePaths: [...(project.sandbox?.writePaths ?? []), ...links],
    },
  };
  job.status = "running";
  job.startedAt = new Date().toISOString();
  await saveJob(job);
  renderer.info(
    `Job ${job.id}: ${job.title}\nBranch ${job.branch} · worktree ${job.worktree}\nApproved: ${job.allow.length === 0 ? "nothing beyond the sandbox" : job.allow.join(", ")}`,
  );
  return { job, root: job.worktree, settings, denied: [], startedAt: Date.now() };
}

/** Wait until the next HH:MM (local time). Ctrl-C cancels the wait; the job stays scheduled. */
async function waitUntil(at: string, renderer: Renderer, job: Job): Promise<number> {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (match === null) {
    renderer.error(`"${at}" is not a time. Use HH:MM, for example 01:00.`);
    return 1;
  }
  const ms = msUntil(Number(match[1]), Number(match[2]));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  renderer.info(
    `Job ${job.id} waits until ${at} (in ${hours} h ${minutes} min). Keep this terminal open and the Mac awake and on power. Ctrl-C cancels the wait.`,
  );
  const cancelled = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      process.off("SIGINT", cancel);
      resolve(false);
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      resolve(true);
    };
    process.once("SIGINT", cancel);
  });
  if (cancelled) {
    renderer.warn(`The wait was cancelled. Job ${job.id} is still scheduled.`);
    return 130;
  }
  return 0;
}

/** Milliseconds from `now` to the next hh:mm (today, or tomorrow when that time has passed). */
export function msUntil(hour: number, minute: number, now: Date = new Date()): number {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** After the turn: commit the changes to the job branch, write the result and the report. */
export async function finishJob(
  prepared: PreparedJob,
  outcome: TurnOutcome,
  runtime: Runtime,
  renderer: Renderer,
  git: Executor = createExecutor("host").executor,
  launchd: LaunchdRun = {},
): Promise<void> {
  const { job } = prepared;
  const hadAgent = job.launchd !== undefined || launchd.fromLaunchd === true;
  delete job.launchd;
  const result: JobResult = {
    stopReason: outcome.kind === "done" ? outcome.result.stopReason : outcome.kind,
    steps: outcome.kind === "done" ? outcome.result.steps : 0,
    tokens: runtime.session === undefined ? 0 : totalTokens(runtime.session.usage),
    ...(runtime.session?.costUsd === undefined ? {} : { costUsd: runtime.session.costUsd }),
    durationMs: Date.now() - prepared.startedAt,
    ...(runtime.session === undefined ? {} : { sessionId: runtime.session.id }),
    files: [],
    denied: prepared.denied,
    answer: lastAnswer(runtime),
    ...(prepared.deadline === undefined
      ? {}
      : {
          modelCalls: {
            batch: prepared.deadline.calls.primary,
            normal: prepared.deadline.calls.fallback,
            slow: prepared.deadline.calls.slow,
            ...(prepared.deadline.calls.switchedAt === undefined
              ? {}
              : { switchedAt: prepared.deadline.calls.switchedAt.toISOString() }),
          },
        }),
    ...(outcome.kind === "error" ? { error: outcome.message } : {}),
  };
  try {
    const commit = await commitJob(
      git,
      job,
      `Garuda job ${job.id}: ${job.title}${outcome.kind === "done" && outcome.result.stopReason === "done" ? "" : ` (${result.stopReason})`}`,
    );
    if (commit !== undefined) result.commit = commit;
    result.files = await jobChanges(git, job);
  } catch (error) {
    if (!(error instanceof JobGitError)) throw error;
    result.error = [result.error, `commit: ${error.message}`].filter(Boolean).join("; ");
  }
  if (outcome.kind !== "interrupted") {
    result.proof = await proveJob(prepared, result, runtime, renderer, git);
  }
  job.status =
    outcome.kind === "error" ? "failed" : outcome.kind === "interrupted" ? "stopped" : "done";
  job.endedAt = new Date().toISOString();
  job.result = result;
  await saveJob(job);
  const report = jobReport(job);
  const file = join(job.root, JOBS_DIR, `${job.id}.md`);
  await writeFile(file, `${report}\n`, { mode: 0o600 });
  renderer.info(`\n${report}\n\nReport: ${file}`);
  const verdict =
    result.proof === undefined
      ? ""
      : result.proof.verdict === "ready"
        ? ", ready to merge"
        : ", needs a look";
  const note = `Garuda: job ${job.id} ${job.status}${verdict} (${result.files.length} file(s) changed)`;
  if (process.stdout.isTTY) {
    process.stdout.write(
      notificationBytes(pickChannel(runtime.notificationSettings?.channel), note),
    );
  } else if (launchd.fromLaunchd === true && process.platform === "darwin") {
    // No terminal: a macOS notification. The text goes as an argument, never as script text.
    await hostCommand(
      git,
      job.root,
      [
        "osascript",
        "-e",
        "on run argv",
        "-e",
        'display notification (item 1 of argv) with title "Garuda"',
        "-e",
        "end run",
        note,
      ],
      { check: false },
    );
  }
  // Last: when this run came from the agent, unloading it ends this process.
  if (hadAgent) await removeAgent(git, job, launchd.env ?? defaultAgentEnv());
}

function lastAnswer(runtime: Runtime): string {
  const messages = runtime.session?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const text = m.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    if (text !== "") return text.length <= 8_000 ? text : `${text.slice(0, 8_000)}\n… [cut]`;
  }
  return "";
}
