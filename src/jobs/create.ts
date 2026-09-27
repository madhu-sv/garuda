import type { Approver } from "../permissions/types.js";
import type { Executor } from "../sandbox/types.js";
import { JobGitError } from "./git.js";
import {
  DEFAULT_JOB_MAX_STEPS,
  type Job,
  jobPath,
  newJobId,
  planPermissions,
  planTitle,
  saveJob,
} from "./job.js";
import { jobPrompt } from "./text.js";
import { jobBase, linkCandidates, worktreeDir } from "./worktree.js";

export interface PlanForJob {
  /** The user's request that led to the plan. */
  request: string;
  /** The plan: the last answer of a plan-mode turn. */
  plan: string;
  sessionId: string;
}

export interface CreateJobOptions {
  root: string;
  executor: Executor;
  approver: Approver;
  plan: PlanForJob;
  modelId: string;
  maxSteps?: number;
  /** "01:00" for `garuda run --at`. */
  at?: string;
  home?: string;
  now?: Date;
  signal: AbortSignal;
}

/**
 * /schedule (0.7): turn the last plan into a job file. It shows the approval list from the plan's
 * ```permissions block and asks once; the job then runs with `garuda run <id>`.
 */
export async function createJob(
  options: CreateJobOptions,
): Promise<{ ok: true; job: Job; text: string } | { ok: false; text: string }> {
  if (options.executor.isolation === "none") {
    return {
      ok: false,
      text: "A job needs the OS sandbox (Seatbelt or bubblewrap): without it, every command would need an approval, and nobody is there to give it.",
    };
  }
  if (options.at !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(options.at)) {
    return { ok: false, text: `"${options.at}" is not a time. Use HH:MM, for example 01:00.` };
  }
  let base: Awaited<ReturnType<typeof jobBase>>;
  try {
    base = await jobBase(options.executor, options.root);
  } catch (error) {
    if (error instanceof JobGitError) return { ok: false, text: error.message };
    throw error;
  }
  const { rules, problems } = planPermissions(options.plan.plan);
  const id = newJobId(options.now);
  const links = linkCandidates(options.root);
  const job: Job = {
    version: 1,
    id,
    title: planTitle(options.plan.request, options.plan.plan),
    createdAt: (options.now ?? new Date()).toISOString(),
    root: options.root,
    base: base.commit,
    branch: `garuda/job-${id}`,
    worktree: worktreeDir(options.root, id, options.home),
    prompt: jobPrompt(options.plan.request, options.plan.plan),
    planSession: options.plan.sessionId,
    model: options.modelId,
    allow: rules,
    onUnapproved: "deny-and-continue",
    ...(options.at === undefined ? {} : { at: options.at }),
    maxSteps: options.maxSteps ?? DEFAULT_JOB_MAX_STEPS,
    links,
    status: "scheduled",
  };
  const preview = [
    `Job: ${job.title}`,
    `Model: ${options.modelId} · up to ${job.maxSteps} steps`,
    `Starts from: ${base.uncommitted ? "your last commit plus your uncommitted changes" : "your last commit"}${base.untracked > 0 ? ` (${base.untracked} untracked file(s) are not included)` : ""}`,
    `Works on: branch ${job.branch}, in its own worktree; your checkout does not change.`,
    ...(links.length === 0 ? [] : [`Links: ${links.join(", ")} from your checkout.`]),
    "",
    "Approved for this job, on top of the sandbox (reads, and commands that stay in the project):",
    ...(rules.length === 0
      ? ["  (nothing: the plan listed no permissions)"]
      : rules.map((r) => `  ${r}`)),
    ...(problems.length === 0
      ? []
      : ["", "Not rules, left out:", ...problems.map((p) => `  ${p}`)]),
    "",
    "Any other call that would ask is denied at run time; the job goes on and reports it.",
  ].join("\n");
  const choice = await options.approver.ask(
    {
      tool: "schedule",
      target: { kind: "input", json: "{}" },
      preview,
      isolation: options.executor.isolation,
      title: "Schedule this plan as a job?",
      question: "Create the job?",
      choices: ["once", "deny"],
      labels: { once: "Yes, create the job", deny: "No" },
    },
    options.signal,
  );
  if (choice === "deny") return { ok: false, text: "No job was created." };
  await saveJob(job);
  const run = `garuda run ${id}${options.at === undefined ? "" : ` --at ${options.at}`}`;
  return {
    ok: true,
    job,
    text: [
      `Created job ${id}: ${jobPath(options.root, id)}`,
      'You can edit its approval list ("allow") in that file before the run.',
      `Run it in a terminal in this folder: ${run}`,
      options.at === undefined
        ? ""
        : "The terminal waits until then; keep the Mac awake and on power.",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  };
}
