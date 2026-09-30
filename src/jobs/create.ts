import type { Approver } from "../permissions/types.js";
import type { Executor } from "../sandbox/types.js";
import { JobGitError } from "./git.js";
import {
  DEFAULT_JOB_MAX_STEPS,
  JOBS_DIR,
  type Job,
  jobPath,
  newJobId,
  planPermissions,
  planTitle,
  saveJob,
} from "./job.js";
import {
  type AgentEnv,
  agentLabel,
  defaultAgentEnv,
  installAgent,
  installSpec,
  nextTime,
  nightAgentTime,
  nightSpec,
} from "./launchd.js";
import { jobPrompt } from "./text.js";
import { jobBase, linkCandidates, worktreeDir } from "./worktree.js";

/** A job on the Batch API must end by this local time; 15 minutes before, it uses the normal API. */
export const DEFAULT_FINISH_BY = "07:00";
/** How long before the finish-by time a batch job switches to the normal API. */
export const SWITCH_BEFORE_MS = 15 * 60_000;
/** A batch step that waits longer than this runs on the normal API (that step only). */
export const DEFAULT_STEP_LIMIT_MINUTES = 20;

/** "06:45" for "07:00". */
export function switchTime(finishBy: string): string {
  const [h, m] = finishBy.split(":").map(Number) as [number, number];
  const minutes = (h * 60 + m - SWITCH_BEFORE_MS / 60_000 + 24 * 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

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
  /** The model can use the Batch API (an Anthropic model): ask whether the job should (0.7). */
  batchCapable?: boolean;
  maxSteps?: number;
  /** "01:00" for `garuda run --at`. */
  at?: string;
  home?: string;
  now?: Date;
  signal: AbortSignal;
  /**
   * macOS with a time: offer a launchd agent (0.7). Only when the caller passes this option (the
   * chat does), so no other caller, and no test, installs an agent on the machine by accident.
   * `platform`, `env` and `executor` are for tests; the default is this process's platform,
   * `defaultAgentEnv()` and the job's executor.
   */
  launchd?: { platform?: NodeJS.Platform; env?: AgentEnv; executor?: Executor };
  /** The project's test command (0.11): run before and after the job. Absent: no tests. */
  test?: string;
  /** The network allowlist in effect in the chat (0.13): the job gets the same one. */
  network?: readonly string[];
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
    ...(options.test === undefined ? {} : { test: options.test }),
    ...(options.network === undefined || options.network.length === 0
      ? {}
      : { network: [...options.network] }),
    queue: true,
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
    job.network === undefined
      ? "Network: none for commands."
      : `Network: ${job.network.join(", ")}, through Garuda's proxy; other hosts are denied and reported.`,
    "",
    options.test === undefined
      ? 'Proof of work: no test command found (set "test" in the job file); a principal-engineer review of the diff (one model call).'
      : `Proof of work: \`${options.test}\` runs in the sandbox before and after the job; a principal-engineer review of the diff (one model call).`,
    "Night shift: the job joins this project's queue; `garuda night` runs the queue (up to 3 jobs at a time) and writes one digest.",
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
  if (options.batchCapable === true) {
    const batch = await options.approver.ask(
      {
        tool: "schedule",
        target: { kind: "input", json: "{}" },
        preview: [
          "Half the token price. Each step waits for its batch: about 3 minutes in Garuda's first measurement, but some batches wait hours.",
          `A step that waits more than ${DEFAULT_STEP_LIMIT_MINUTES} minutes runs on the normal API (full price); the next step tries the Batch API again.`,
          `At ${switchTime(DEFAULT_FINISH_BY)} (15 minutes before the finish-by time ${DEFAULT_FINISH_BY}), a job that still runs goes on with the normal API. You can change "finishBy" and "stepLimitMinutes" in the job file.`,
        ].join("\n"),
        isolation: options.executor.isolation,
        title: "Use the Batch API for this job?",
        question: "Use the Batch API?",
        choices: ["once", "deny"],
        labels: { once: "Yes, half price, slower", deny: "No, the normal API" },
      },
      options.signal,
    );
    if (batch !== "deny") {
      job.batch = true;
      job.finishBy = DEFAULT_FINISH_BY;
      job.stepLimitMinutes = DEFAULT_STEP_LIMIT_MINUTES;
    }
  }
  await saveJob(job);
  const lines = [
    `Created job ${id}: ${jobPath(options.root, id)}`,
    'You can edit its approval list ("allow") in that file before the run.',
  ];
  const platform = options.launchd?.platform ?? process.platform;
  if (options.launchd !== undefined && options.at !== undefined && platform === "darwin") {
    const agent = await offerAgent(job, options);
    if (agent !== undefined) return { ok: true, job, text: [...lines, agent].join("\n") };
  }
  const at = options.at === undefined ? "" : ` --at ${options.at}`;
  lines.push(
    `Run the night queue in a terminal in this folder: garuda night${at} (or this job alone: garuda run ${id}${at})`,
  );
  if (options.at !== undefined) {
    lines.push("The terminal waits until then; keep the Mac awake and on power.");
  }
  return { ok: true, job, text: lines.join("\n") };
}

/**
 * The second question on macOS: start the night queue (0.11) or only this job with launchd. The
 * text for the user; undefined = No.
 */
async function offerAgent(job: Job, options: CreateJobOptions): Promise<string | undefined> {
  const env = options.launchd?.env ?? defaultAgentEnv();
  const at = job.at as string;
  const when = nextTime(at, options.now);
  const day = when.toDateString();
  const earlier = nightAgentTime(job.root, env);
  const choice = await options.approver.ask(
    {
      tool: "schedule",
      target: { kind: "input", json: "{}" },
      preview: [
        `launchd starts the night queue (every queued job, up to 3 at a time, then one digest) at ${at} on ${day}, also when no terminal is open. Or only this job.`,
        ...(earlier === undefined
          ? []
          : [
              `The queue's agent now starts at ${earlier.toTimeString().slice(0, 5)} on ${earlier.toDateString()}: it moves to ${at}.`,
            ]),
        `It runs through your login shell (${env.shell} -lic), so your shell setup gives it the API keys; no key is written to a file.`,
        "caffeinate keeps the Mac from idle sleep while it runs. If the Mac sleeps at that time, it starts at the next wake.",
        `Logs: ${JOBS_DIR}/night.log (the queue) or ${JOBS_DIR}/${job.id}.log (one job). /jobs cancel night (or ${job.id}) removes it; it removes itself after it runs.`,
      ].join("\n"),
      isolation: options.executor.isolation,
      title: `Start at ${at} with launchd?`,
      question: "Add a launchd agent?",
      choices: ["once", "session", "deny"],
      labels: {
        once: "Yes, the whole night queue",
        session: "Only this job",
        deny: "No, I will run it myself",
      },
    },
    options.signal,
  );
  if (choice === "deny") return undefined;
  const executor = options.launchd?.executor ?? options.executor;
  if (choice === "once") {
    try {
      await installSpec(executor, nightSpec(job.root), env, when);
      return `launchd starts the night queue at ${at} on ${day}. Keep the Mac on power. Log: ${JOBS_DIR}/night.log. Cancel: /jobs cancel night.`;
    } catch (error) {
      return `The launchd agent failed (${(error as Error).message}). Run the queue in a terminal instead: garuda night --at ${at}`;
    }
  }
  try {
    const installed = await installAgent(executor, job, env, options.now);
    job.launchd = {
      label: agentLabel(job.id),
      plist: installed.plist,
      when: installed.when.toISOString(),
    };
    await saveJob(job);
    return `launchd starts it at ${at} on ${day}; it leaves the night queue. Keep the Mac on power. Log: ${JOBS_DIR}/${job.id}.log. Cancel: /jobs cancel ${job.id}.`;
  } catch (error) {
    return `The launchd agent failed (${(error as Error).message}). Run it in a terminal instead: garuda run ${job.id} --at ${at}`;
  }
}
