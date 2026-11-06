import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTestCount } from "../app/receipt.js";
import { JOBS_DIR, type Job, listJobs } from "./job.js";
import { formatCost, jobCost, sumCosts } from "./text.js";

/**
 * The morning brief (UX U7; docs/lld/ux.md): the first chat after jobs ran shows them once, with
 * each job's verdict, tests and branch. `.garuda/jobs/brief.seen` keeps the time of the last
 * brief, so the next chat does not show the same jobs again.
 */

// Not a .json name: listJobs reads every .json file in the folder as a job.
export const BRIEF_FILE = "brief.seen";
/** With no brief file yet: the jobs that ended in the last day. */
export const FIRST_BRIEF_MS = 24 * 3_600_000;

export type BriefPaint = (style: "green" | "red" | "dim" | "bold", text: string) => string;

/** "tests 120 → 126", "tests pass", "tests fail after the change", or "no tests". */
export function testsText(job: Job): string {
  const proof = job.result?.proof;
  const after = proof?.after;
  if (after === undefined) return "no tests";
  const count = (tail: string | undefined) =>
    tail === undefined ? undefined : parseTestCount(tail)?.total;
  const before = count(proof?.before?.tail);
  const now = count(after.tail);
  const passed = after.exitCode === 0 && !after.timedOut;
  if (before !== undefined && now !== undefined && passed) return `tests ${before} → ${now}`;
  return passed ? "tests pass" : "tests fail after the change";
}

/** One job's line: the mark, the title, the verdict, the tests, the branch. */
export function jobLine(job: Job, paint: BriefPaint): string {
  const verdict = job.result?.proof?.verdict;
  const ok = job.status === "done" && verdict === "ready";
  const mark = ok ? paint("green", "✓") : paint("red", "✗");
  const what =
    verdict === "ready"
      ? "ready to merge"
      : verdict === "needs-look"
        ? "needs a look"
        : job.status === "done"
          ? "done, no verdict"
          : job.status;
  const title = job.title.length > 32 ? `${job.title.slice(0, 31)}…` : job.title;
  return `  ${mark} ${title.padEnd(32)}  ${what.padEnd(16)}  ${testsText(job).padEnd(26)}  ${paint("dim", job.branch)}`;
}

/** The brief's text for jobs that ended, or undefined for none. */
export function briefText(jobs: readonly Job[], paint: BriefPaint): string | undefined {
  if (jobs.length === 0) return undefined;
  const cost = sumCosts(jobs.flatMap((j) => (j.result === undefined ? [] : [jobCost(j.result)])));
  return [
    paint(
      "bold",
      `While you were away: ${jobs.length} job${jobs.length === 1 ? "" : "s"} ran (${formatCost(cost)})`,
    ),
    ...jobs.map((j) => jobLine(j, paint)),
    paint(
      "dim",
      "  /jobs <id> shows a job's report and review · git diff <base>...<branch> shows its change",
    ),
  ].join("\n");
}

/** The jobs that ended after `since`, oldest first. */
export function endedSince(jobs: readonly Job[], since: number): Job[] {
  return jobs
    .filter((j) => j.endedAt !== undefined && Date.parse(j.endedAt) > since)
    .filter((j) => j.status === "done" || j.status === "stopped" || j.status === "failed")
    .sort((a, b) => Date.parse(a.endedAt ?? "") - Date.parse(b.endedAt ?? ""));
}

/**
 * The brief for this chat start, once: the jobs that ended since the last brief (or in the last
 * day), and the time of this brief saved. A folder that cannot be read or written gives none.
 */
export async function morningBrief(
  root: string,
  paint: BriefPaint,
  now = Date.now(),
): Promise<string | undefined> {
  const dir = join(root, JOBS_DIR);
  const file = join(dir, BRIEF_FILE);
  let since = now - FIRST_BRIEF_MS;
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as { seenAt?: unknown };
    if (typeof data.seenAt === "string" && !Number.isNaN(Date.parse(data.seenAt))) {
      since = Date.parse(data.seenAt);
    }
  } catch {
    // No brief yet: the last day.
  }
  const jobs = endedSince(await listJobs(root), since);
  if (jobs.length === 0) return undefined;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, `${JSON.stringify({ seenAt: new Date(now).toISOString() })}\n`);
  } catch {
    // The brief is a help: it may show again next time.
  }
  return briefText(jobs, paint);
}
