import { realpathSync } from "node:fs";
import { loadJob } from "../jobs/job.js";
import { defaultAgentEnv } from "../jobs/launchd.js";
import {
  DEFAULT_NIGHT_PARALLEL,
  type JobRunner,
  MAX_NIGHT_PARALLEL,
  nightDigest,
  nightQueue,
  processRunner,
  runQueue,
  writeDigest,
} from "../jobs/night.js";
import { createExecutor } from "../sandbox/index.js";
import { msUntil } from "./jobCommand.js";
import { notificationBytes, pickChannel } from "./notify.js";
import type { Renderer } from "./renderer.js";

/**
 * `garuda night [--at HH:MM] [--parallel n]` (0.11, W1): run this project's night queue, then write
 * one digest and send one notification.
 */
export async function nightCommand(
  options: { at?: string; parallel?: string },
  renderer: Renderer,
  runner?: JobRunner,
  root: string = realpathSync(process.cwd()),
): Promise<number> {
  const parallel =
    options.parallel === undefined ? DEFAULT_NIGHT_PARALLEL : Number(options.parallel);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > MAX_NIGHT_PARALLEL) {
    renderer.error(`--parallel takes 1 to ${MAX_NIGHT_PARALLEL}.`);
    return 1;
  }
  if (options.at !== undefined) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(options.at);
    if (m === null) {
      renderer.error(`"${options.at}" is not a time. Use HH:MM, for example 01:00.`);
      return 1;
    }
    const ms = msUntil(Number(m[1]), Number(m[2]));
    renderer.info(
      `The night shift starts at ${options.at} (in ${Math.floor(ms / 3_600_000)} h ${Math.round((ms % 3_600_000) / 60_000)} min). Keep this terminal open and the Mac awake and on power. Ctrl-C cancels.`,
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
      renderer.warn("The wait was cancelled. The queue is unchanged.");
      return 130;
    }
  }
  const queue = await nightQueue(root);
  if (queue.length === 0) {
    renderer.info("The night queue is empty. Make a plan (/plan), then /schedule adds it.");
    return 0;
  }
  const started = new Date();
  renderer.info(
    `Night shift: ${queue.length} job(s), up to ${parallel} at a time. Each job logs to .garuda/jobs/<id>.log.`,
  );
  const run = runner ?? processRunner(createExecutor("host").executor, defaultAgentEnv());
  await runQueue(queue, run, parallel, {
    onStart: (job) => renderer.info(`▶ ${job.id}: ${job.title}`),
    onEnd: (job, code) => renderer.info(`■ ${job.id} ended (exit code ${code ?? "none"})`),
  });
  const jobs = await Promise.all(queue.map((j) => loadJob(root, j.id).catch(() => j)));
  const digest = nightDigest(jobs, started, new Date());
  const file = await writeDigest(root, digest, started);
  renderer.info(`\n${digest}\n\nDigest: ${file}`);
  const ready = jobs.filter((j) => j.result?.proof?.verdict === "ready").length;
  if (process.stdout.isTTY) {
    process.stdout.write(
      notificationBytes(
        pickChannel(undefined),
        `Garuda night shift: ${jobs.length} job(s), ${ready} ready to merge`,
      ),
    );
  }
  return 0;
}
