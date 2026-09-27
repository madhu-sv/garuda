import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Executor } from "../sandbox/types.js";
import { type GitResult, git, JobGitError } from "./git.js";
import type { Job, JobResult } from "./job.js";

/**
 * The job's own checkout (0.7): a git worktree on the branch garuda/job-<id>, in
 * ~/.garuda/worktrees/<project>-<hash>/<id>. The user's checkout, index and uncommitted work stay as
 * they are; the job's changes land as one commit on its branch.
 */

/** Ignored folders that a job needs to build and test: linked from the checkout, never copied. */
export const LINK_CANDIDATES = ["node_modules", ".venv", "venv"];

/** Garuda's own files, never part of the job's commit. */
const NEVER_COMMIT = [".garuda/sessions", ".garuda/index", ".garuda/evals", ".garuda/jobs"];

export function worktreeDir(root: string, id: string, home: string = homedir()): string {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return join(home, ".garuda", "worktrees", `${basename(root)}-${hash}`, id);
}

export interface JobBase {
  commit: string;
  /** True when the base holds uncommitted changes of tracked files (`git stash create`). */
  uncommitted: boolean;
  /** Untracked files that the job will not see. */
  untracked: number;
}

/** Where the job starts: HEAD, or HEAD plus the uncommitted changes of tracked files. */
export async function jobBase(executor: Executor, root: string): Promise<JobBase> {
  const head = await git(executor, root, ["rev-parse", "--verify", "HEAD"], { check: false });
  if (head.exitCode !== 0) {
    throw new JobGitError("A job needs a git repository with at least one commit.");
  }
  const commit = head.stdout.trim();
  const stash = (await git(executor, root, ["stash", "create"])).stdout.trim();
  const untracked = (
    await git(executor, root, ["ls-files", "--others", "--exclude-standard"])
  ).stdout
    .split("\n")
    // Garuda's own files (sessions, jobs) are not the user's work.
    .filter((l) => l !== "" && !l.startsWith(".garuda/")).length;
  if (stash === "") return { commit, uncommitted: false, untracked };
  // A plain commit of the stash's tree on HEAD: the branch history stays linear.
  const tree = `${stash}^{tree}`;
  const base = await git(executor, root, [
    "commit-tree",
    tree,
    "-p",
    commit,
    "-m",
    "Garuda job base: uncommitted changes at scheduling time",
  ]);
  return { commit: base.stdout.trim(), uncommitted: true, untracked };
}

/** The ignored folders of the checkout that the worktree should link to. */
export function linkCandidates(root: string): string[] {
  return LINK_CANDIDATES.filter((name) => {
    try {
      return lstatSync(join(root, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Create the worktree on the job branch (or reuse it after an earlier run), and link the ignored
 * folders. Returns the real paths of the linked folders: the sandbox may write there (caches).
 */
export async function prepareWorktree(
  executor: Executor,
  job: Job,
  signal?: AbortSignal,
): Promise<{ links: string[] }> {
  if (!existsSync(join(job.worktree, ".git"))) {
    await mkdir(join(job.worktree, ".."), { recursive: true, mode: 0o700 });
    const branch = await git(
      executor,
      job.root,
      ["rev-parse", "--verify", `refs/heads/${job.branch}`],
      { check: false, ...(signal === undefined ? {} : { signal }) },
    );
    const args =
      branch.exitCode === 0
        ? ["worktree", "add", job.worktree, job.branch]
        : ["worktree", "add", "-b", job.branch, job.worktree, job.base];
    await git(executor, job.root, args, signal === undefined ? {} : { signal });
  }
  const links: string[] = [];
  for (const name of job.links) {
    const target = join(job.root, name);
    const link = join(job.worktree, name);
    if (!existsSync(target)) continue;
    if (!existsSync(link)) await symlink(target, link, "dir");
    links.push(realpathSync(target));
  }
  return { links };
}

/**
 * Commit the job's changes on its branch (no hooks), without Garuda's own files and the links.
 * Returns the commit id, or undefined when nothing changed.
 */
export async function commitJob(
  executor: Executor,
  job: Job,
  message: string,
): Promise<string | undefined> {
  const exclude = [...NEVER_COMMIT, ...job.links].map((p) => `:(exclude)${p}`);
  await git(executor, job.worktree, ["add", "-A", "--", ".", ...exclude]);
  const staged = await git(executor, job.worktree, ["diff", "--cached", "--quiet"], {
    check: false,
  });
  if (staged.exitCode === 0) return undefined;
  await git(executor, job.worktree, ["commit", "--no-verify", "-q", "-m", message]);
  return (await git(executor, job.worktree, ["rev-parse", "HEAD"])).stdout.trim();
}

/** The files the job branch changed since its base, with line counts. */
export async function jobChanges(executor: Executor, job: Job): Promise<JobResult["files"]> {
  const range = [job.base, job.branch];
  const names = await git(executor, job.root, [
    "diff",
    "--no-renames",
    "--name-status",
    "-z",
    ...range,
  ]);
  const counts = await git(executor, job.root, [
    "diff",
    "--no-renames",
    "--numstat",
    "-z",
    ...range,
  ]);
  return parseChanges(names, counts);
}

function parseChanges(names: GitResult, counts: GitResult): JobResult["files"] {
  const lines = new Map<string, { added?: number; removed?: number }>();
  for (const entry of counts.stdout.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(entry);
    if (m === null) continue;
    lines.set(m[3] as string, m[1] === "-" ? {} : { added: Number(m[1]), removed: Number(m[2]) });
  }
  const parts = names.stdout.split("\0").filter((p) => p !== "");
  const files: JobResult["files"] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i];
    const path = parts[i + 1] as string;
    files.push({
      status: code === "A" ? "added" : code === "D" ? "deleted" : "modified",
      path,
      ...lines.get(path),
    });
  }
  return files;
}
