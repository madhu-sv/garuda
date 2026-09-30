import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseRule } from "../permissions/rules.js";

/**
 * Scheduled jobs (0.7): a plan that runs later with nobody at the keyboard. A job is one JSON file
 * in `<root>/.garuda/jobs/<id>.json`. The user may edit it before the run (for example the approval
 * list); Garuda checks it again when it loads it.
 */

export const JOBS_DIR = join(".garuda", "jobs");
export const DEFAULT_JOB_MAX_STEPS = 100;

export const JOB_STATUSES = ["scheduled", "running", "done", "stopped", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const fileChange = z.object({
  status: z.enum(["added", "modified", "deleted"]),
  path: z.string(),
  added: z.number().optional(),
  removed: z.number().optional(),
});

const testRun = z.object({
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number(),
  tail: z.string(),
});

const resultSchema = z.object({
  stopReason: z.string(),
  steps: z.number(),
  tokens: z.number(),
  costUsd: z.number().optional(),
  durationMs: z.number(),
  sessionId: z.string().optional(),
  commit: z.string().optional(),
  files: z.array(fileChange),
  denied: z.array(z.object({ tool: z.string(), target: z.string() })),
  answer: z.string(),
  error: z.string().optional(),
  /** With the Batch API: requests per API, and when the job switched to the normal API. */
  modelCalls: z
    .object({
      batch: z.number(),
      normal: z.number(),
      /** Steps that waited past the step limit and ran on the normal API. */
      slow: z.number().optional(),
      switchedAt: z.string().optional(),
    })
    .optional(),
  /** Proof of work (0.11): tests before and after, risk flags, the review and the verdict. */
  proof: z
    .object({
      verdict: z.enum(["ready", "needs-look"]),
      before: testRun.optional(),
      after: testRun.optional(),
      flags: z.array(z.object({ level: z.enum(["stop", "look"]), text: z.string() })),
      review: z
        .object({
          verdict: z.enum(["ready", "needs-look"]),
          text: z.string(),
          costUsd: z.number().optional(),
        })
        .optional(),
      reviewError: z.string().optional(),
    })
    .optional(),
});

const jobSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  title: z.string(),
  createdAt: z.string(),
  /** The project folder the job belongs to (the user's checkout). */
  root: z.string(),
  /** The commit the job starts from: HEAD, or a snapshot of the uncommitted changes. */
  base: z.string().regex(/^[0-9a-f]{40,64}$/),
  branch: z.string().regex(/^garuda\/job-[A-Za-z0-9_-]+$/),
  worktree: z.string(),
  /** The task: the plan and how to carry it out. */
  prompt: z.string().min(1),
  /** The session the plan came from. */
  planSession: z.string().optional(),
  model: z.string().optional(),
  /** Permission rules for this job only, in the settings format ("edit_file(src/**)"). */
  allow: z.array(z.string()),
  onUnapproved: z.literal("deny-and-continue"),
  /** "01:00" (local time) for `garuda run --at`, when the user gave one. */
  at: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  maxSteps: z.number().int().min(1).max(1_000),
  /** The Batch API (0.7): half price, minutes per step; the normal API from 15 min before finishBy. */
  batch: z.boolean().optional(),
  finishBy: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  /** A batch step that waits longer goes to the normal API (only that step). Default 20. */
  stepLimitMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional(),
  /** Ignored folders of the checkout (node_modules, .venv) that the worktree links to. */
  links: z.array(z.string()),
  /**
   * Proof of work (0.11): the test command, run in the sandbox before and after the job (absent:
   * no tests), and the review of the diff (default true).
   */
  test: z.string().min(1).optional(),
  review: z.boolean().optional(),
  /**
   * The network allowlist (0.13): presets and hosts that the job's sandboxed commands may reach,
   * approved with the job. Other hosts are denied and reported. Absent: no network.
   */
  network: z.array(z.string()).optional(),
  /** In the project's night queue (0.11): `garuda night` runs it. */
  queue: z.boolean().optional(),
  /** The launchd agent that starts the job (macOS), while it is installed. */
  launchd: z.object({ label: z.string(), plist: z.string(), when: z.string() }).optional(),
  status: z.enum(JOB_STATUSES),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  result: resultSchema.optional(),
});

export type Job = z.infer<typeof jobSchema>;
export type JobResult = z.infer<typeof resultSchema>;

/** A job id that sorts by time: 20260927-2300-a1b2. */
export function newJobId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `${date}-${pad(now.getHours())}${pad(now.getMinutes())}-${randomBytes(2).toString("hex")}`;
}

export function jobPath(root: string, id: string): string {
  return join(root, JOBS_DIR, `${id}.json`);
}

/** Write the job file: a temp file, then a rename, so a crash never leaves half a file. */
export async function saveJob(job: Job): Promise<void> {
  const dir = join(job.root, JOBS_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = jobPath(job.root, job.id);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

/** Load and check a job. The rules must parse; the root must be this project. */
export async function loadJob(root: string, id: string): Promise<Job> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error(`"${id}" is not a job id.`);
  let text: string;
  try {
    text = await readFile(jobPath(root, id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`There is no job ${id} in this project (${JOBS_DIR}).`);
    }
    throw error;
  }
  let parsed: Job;
  try {
    const result = jobSchema.safeParse(JSON.parse(text));
    if (!result.success) throw new Error(z.prettifyError(result.error));
    parsed = result.data;
  } catch (error) {
    throw new Error(`${JOBS_DIR}/${id}.json: ${(error as Error).message}`);
  }
  if (parsed.root !== root) {
    throw new Error(`Job ${id} belongs to ${parsed.root}, not to ${root}.`);
  }
  for (const rule of parsed.allow) parseRule(rule);
  return parsed;
}

/** The jobs of this project, newest first. Broken files are skipped. */
export async function listJobs(root: string): Promise<Job[]> {
  let names: string[];
  try {
    names = (await readdir(join(root, JOBS_DIR))).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const jobs: Job[] = [];
  for (const name of names.sort().reverse()) {
    try {
      jobs.push(await loadJob(root, name.slice(0, -".json".length)));
    } catch {
      // A broken or foreign file: /jobs <id> shows the problem.
    }
  }
  return jobs;
}

/**
 * The rules in a plan's ```permissions block: one rule per line, in the settings format. Lines that
 * do not parse come back as problems; blank lines and "#" comments are skipped.
 */
export function planPermissions(plan: string): { rules: string[]; problems: string[] } {
  const block = /```permissions[^\n]*\n([\s\S]*?)```/.exec(plan)?.[1];
  const rules: string[] = [];
  const problems: string[] = [];
  for (const raw of (block ?? "").split("\n")) {
    const line = raw.replace(/^\s*[-*]\s+/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    try {
      parseRule(line);
      if (!rules.includes(line)) rules.push(line);
    } catch {
      problems.push(line);
    }
  }
  return { rules, problems };
}

/** The first line of the plan that says something, for the job title. */
export function planTitle(prompt: string, plan: string): string {
  const line =
    prompt
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ??
    plan.split("\n").find((l) => l.trim() !== "") ??
    "job";
  const clean = line.replace(/^#+\s*/, "");
  return clean.length <= 70 ? clean : `${clean.slice(0, 69)}…`;
}
