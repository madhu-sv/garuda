import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "../app/runtime.js";
import { JobGitError } from "../jobs/git.js";
import { JOBS_DIR, type Job, type JobResult, loadJob, saveJob } from "../jobs/job.js";
import { jobReport } from "../jobs/text.js";
import { commitJob, jobChanges, prepareWorktree } from "../jobs/worktree.js";
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
}

/** Load the job, wait for --at, make its worktree, and build its settings. A number = exit code. */
export async function prepareJob(
  mainRoot: string,
  id: string,
  at: string | undefined,
  renderer: Renderer,
  git: Executor = createExecutor("host").executor,
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
): Promise<void> {
  const { job } = prepared;
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
  job.status =
    outcome.kind === "error" ? "failed" : outcome.kind === "interrupted" ? "stopped" : "done";
  job.endedAt = new Date().toISOString();
  job.result = result;
  await saveJob(job);
  const report = jobReport(job);
  const file = join(job.root, JOBS_DIR, `${job.id}.md`);
  await writeFile(file, `${report}\n`, { mode: 0o600 });
  renderer.info(`\n${report}\n\nReport: ${file}`);
  if (process.stdout.isTTY) {
    process.stdout.write(
      notificationBytes(
        pickChannel(runtime.notificationSettings?.channel),
        `Garuda: job ${job.id} ${job.status} (${result.files.length} file(s) changed)`,
      ),
    );
  }
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
