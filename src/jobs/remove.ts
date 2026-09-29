import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Executor } from "../sandbox/types.js";
import { git } from "./git.js";
import { JOBS_DIR, type Job, jobPath } from "./job.js";

/**
 * /jobs delete (0.11): what a job left behind, and its removal. The job file, report and log go;
 * the worktree goes; the branch goes only when the caller says so (it may hold work to merge).
 */

export interface JobLeftovers {
  files: string[];
  worktree: boolean;
  /** The job branch exists. */
  branch: boolean;
  /** The branch is in the checkout's HEAD (merged), so deleting it loses nothing. */
  merged: boolean;
}

export async function jobLeftovers(executor: Executor, job: Job): Promise<JobLeftovers> {
  const files = [
    jobPath(job.root, job.id),
    ...["md", "log"].map((e) => join(job.root, JOBS_DIR, `${job.id}.${e}`)),
  ].filter((f) => existsSync(f));
  const ref = await git(
    executor,
    job.root,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${job.branch}`],
    {
      check: false,
    },
  );
  const branch = ref.exitCode === 0;
  const merged =
    branch &&
    (
      await git(executor, job.root, ["merge-base", "--is-ancestor", job.branch, "HEAD"], {
        check: false,
      })
    ).exitCode === 0;
  return { files, worktree: existsSync(job.worktree), branch, merged };
}

/** Remove the leftovers; the branch only with `withBranch`. Returns what went, for the user. */
export async function removeJob(
  executor: Executor,
  job: Job,
  left: JobLeftovers,
  withBranch: boolean,
): Promise<string[]> {
  const gone: string[] = [];
  if (left.worktree) {
    await git(executor, job.root, ["worktree", "remove", "--force", job.worktree], {
      check: false,
    });
    await rm(job.worktree, { recursive: true, force: true });
    gone.push("the worktree");
  }
  await git(executor, job.root, ["worktree", "prune"], { check: false });
  if (withBranch && left.branch) {
    await git(executor, job.root, ["branch", "-D", job.branch]);
    gone.push(`the branch ${job.branch}`);
  }
  for (const file of left.files) await rm(file, { force: true });
  if (left.files.length > 0) gone.unshift("the job file, report and log");
  return gone;
}
