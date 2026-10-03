import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Executor } from "../sandbox/types.js";
import { shellWord } from "./git.js";
import { JOBS_DIR, type Job, listJobs } from "./job.js";
import type { AgentEnv } from "./launchd.js";
import { testSummary } from "./proof.js";

/**
 * The night shift (0.11, W1): one queue of jobs per project. `/schedule` puts each new job in the
 * queue; `garuda night` runs the queued jobs, up to `parallel` at a time (each in its own worktree,
 * as its own `garuda run <id>` process with its own log), then writes one digest and sends one
 * notification.
 */

export const DEFAULT_NIGHT_PARALLEL = 3;
export const MAX_NIGHT_PARALLEL = 10;
/** Most time for one job process (the Batch API can take hours). */
const JOB_PROCESS_TIMEOUT_MS = 24 * 3_600_000;

/** The queued jobs, oldest first: scheduled, in the queue, and with no launchd agent of their own. */
export async function nightQueue(root: string): Promise<Job[]> {
  const jobs = await listJobs(root);
  return jobs
    .filter((j) => j.status === "scheduled" && j.queue === true && j.launchd === undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Runs one job to its end; resolves with the process exit code. */
export type JobRunner = (job: Job) => Promise<number | null>;

/**
 * The runner for real nights: `garuda run <id>` as its own process, in the project, with the
 * environment of this process (the API keys), its output in `.garuda/jobs/<id>.log`.
 */
export function processRunner(executor: Executor, env: AgentEnv): JobRunner {
  const program =
    env.script === "" || env.script === env.node
      ? shellWord(env.node)
      : `${shellWord(env.node)} ${shellWord(env.script)}`;
  return async (job) => {
    const log = join(job.root, JOBS_DIR, `${job.id}.log`);
    const result = await executor.run(
      `${program} run ${shellWord(job.id)} >> ${shellWord(log)} 2>&1`,
      {
        root: job.root,
        sandbox: false,
        writePaths: [],
        denyWritePaths: [],
        denyReadPaths: [],
        network: true,
        envAllowlist: [],
        timeoutMs: JOB_PROCESS_TIMEOUT_MS,
        maxOutputBytes: 10_000,
      },
      { env: processEnv() },
    );
    return result.exitCode;
  };
}

/** This process's environment as strings (the job process needs the same API keys). */
function processEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Run the jobs, `parallel` at a time, in queue order. `onStart` and `onEnd` report progress. */
export async function runQueue(
  jobs: readonly Job[],
  run: JobRunner,
  parallel: number,
  report: {
    onStart?: (job: Job) => void;
    onEnd?: (job: Job, code: number | null) => void;
    /** After each job process: check the job's file (0.14.1). */
    settle?: (job: Job, code: number | null) => Promise<void>;
  } = {},
): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const job = jobs[next++];
      if (job === undefined) return;
      report.onStart?.(job);
      let code: number | null = null;
      try {
        code = await run(job);
      } catch {
        code = null;
      }
      await report.settle?.(job, code).catch(() => {});
      report.onEnd?.(job, code);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, jobs.length)) }, worker));
}

/** The morning digest (Markdown): one row per job, then what to do. */
export function nightDigest(jobs: readonly Job[], started: Date, ended: Date): string {
  const ready = jobs.filter((j) => j.result?.proof?.verdict === "ready");
  const cost = jobs.reduce(
    (sum, j) => sum + (j.result?.costUsd ?? 0) + (j.result?.proof?.review?.costUsd ?? 0),
    0,
  );
  const lines = [
    `# Garuda night shift: ${local(started)}`,
    "",
    `${jobs.length} job(s): ${ready.length} ready to merge, ${jobs.length - ready.length} need a look. Time ${Math.round((ended.getTime() - started.getTime()) / 60_000)} min · cost $${cost.toFixed(4)}.`,
    "",
    "| Job | Verdict | Tests after | Files | Cost | Branch |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const j of jobs) {
    const r = j.result;
    const verdict =
      r?.proof === undefined
        ? j.status
        : r.proof.verdict === "ready"
          ? "ready to merge"
          : "needs a look";
    const jobCost =
      r === undefined ? "–" : `$${((r.costUsd ?? 0) + (r.proof?.review?.costUsd ?? 0)).toFixed(4)}`;
    lines.push(
      `| ${j.id}: ${cell(j.title)} | ${verdict} | ${j.test === undefined ? "no tests" : testSummary(r?.proof?.after)} | ${r?.files.length ?? 0} | ${jobCost} | ${j.branch} |`,
    );
  }
  const looks = jobs.filter((j) => j.result?.proof?.verdict !== "ready");
  if (looks.length > 0) {
    lines.push("", "## Needs a look", "");
    for (const j of looks) {
      const flags = j.result?.proof?.flags.map((f) => f.text) ?? [];
      const summary = /^SUMMARY:\s*(.+)$/m.exec(j.result?.proof?.review?.text ?? "")?.[1];
      const why = [...flags, ...(summary === undefined ? [] : [`Review: ${summary}`])];
      lines.push(`- ${j.id}: ${why.length === 0 ? `status ${j.status}` : why.join(" ")}`);
    }
  }
  lines.push(
    "",
    "## Next",
    "",
    "Each job's report: `/jobs <id>` or `.garuda/jobs/<id>.md`. Merge a ready branch with `git merge <branch>`.",
  );
  return lines.join("\n");
}

/** Write the digest next to the job files; returns its path. */
export async function writeDigest(root: string, text: string, started: Date): Promise<string> {
  const file = join(root, JOBS_DIR, `night-${stamp(started)}.md`);
  await writeFile(file, `${text}\n`, { mode: 0o600 });
  return file;
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

const pad = (n: number) => String(n).padStart(2, "0");

function local(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
