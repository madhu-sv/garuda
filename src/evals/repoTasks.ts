import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { git } from "../jobs/git.js";
import { MANIFEST, TEST_PATH } from "../jobs/proof.js";
import { LINK_CANDIDATES } from "../jobs/worktree.js";
import { DEFAULT_ENV_ALLOWLIST } from "../permissions/engine.js";
import type { Executor } from "../sandbox/types.js";
import { TOOLCHAIN_ENV } from "./toolchains.js";
import type { EvalTask } from "./types.js";

/**
 * Benchmark your repo (0.12, W3): eval tasks from the repository's own history. A recent commit
 * that changed code and tests becomes a task: start at its parent, add the commit's test changes,
 * give its message as the task, and pass when the tests pass with the test files unchanged
 * ("visible tests", as SWE-bench does). A candidate is kept only when the tests fail at the parent
 * and pass at the commit. The suite is saved in `.garuda/evals/repo-suite.json`.
 */

export const REPO_SUITE_FILE = join(".garuda", "evals", "repo-suite.json");
export const DEFAULT_COMMITS = 200;
export const DEFAULT_MAX_TASKS = 30;
export const MAX_TASK_FILES = 10;
/** Most time for one test run while the suite is built. */
const BUILD_TEST_TIMEOUT_MS = 5 * 60_000;

const testFile = z.object({ path: z.string(), content: z.string().nullable() });
const taskSchema = z.object({
  id: z.string(),
  sha: z.string(),
  base: z.string(),
  subject: z.string(),
  prompt: z.string(),
  tests: z.array(testFile),
});
const suiteSchema = z.object({
  version: z.literal(1),
  root: z.string(),
  head: z.string(),
  createdAt: z.string(),
  testCommand: z.string(),
  tasks: z.array(taskSchema),
});

export type RepoTaskSpec = z.infer<typeof taskSchema>;
export type RepoSuite = z.infer<typeof suiteSchema>;

/** A commit with the files it changed. */
export interface CommitInfo {
  sha: string;
  subject: string;
  body: string;
  files: { path: string; added?: number; removed?: number }[];
}

/** Why a commit is not a candidate, or undefined when it is one (pure). */
export function skipReason(commit: CommitInfo): string | undefined {
  const { files } = commit;
  if (files.length === 0) return "no files";
  if (files.length > MAX_TASK_FILES) return `more than ${MAX_TASK_FILES} files`;
  if (files.some((f) => f.added === undefined)) return "a binary file";
  if (files.some((f) => MANIFEST.test(f.path))) return "dependencies changed";
  const tests = files.filter((f) => TEST_PATH.test(f.path));
  if (tests.length === 0) return "no test change";
  if (tests.length === files.length) return "only tests changed";
  return undefined;
}

/** The task text: the commit message, and where the tests are (visible tests). */
export function repoPrompt(
  commit: Pick<CommitInfo, "subject" | "body">,
  tests: readonly string[],
): string {
  return [
    commit.subject.trim(),
    ...(commit.body.trim() === "" ? [] : ["", commit.body.trim()]),
    "",
    `The tests for this change are already in the project: ${tests.join(", ")}. Make the change so that they pass. Do not change these test files.`,
  ].join("\n");
}

/** Recent commits on HEAD (no merges), newest first, with their files and line counts. */
export async function recentCommits(
  executor: Executor,
  root: string,
  options: { commits?: number; since?: string } = {},
): Promise<CommitInfo[]> {
  const log = await git(executor, root, [
    "log",
    "--no-merges",
    "--format=%H%x00%s%x00%b%x1e",
    `-n${options.commits ?? DEFAULT_COMMITS}`,
    ...(options.since === undefined ? [] : [`--since=${options.since}`]),
    "HEAD",
  ]);
  const out: CommitInfo[] = [];
  for (const entry of log.stdout.split("\x1e")) {
    const [sha = "", subject = "", body = ""] = entry.replace(/^\n/, "").split("\0");
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
    const stat = await git(executor, root, ["show", "--no-renames", "--numstat", "--format=", sha]);
    const files = stat.stdout
      .split("\n")
      .map((line) => /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) =>
        m[1] === "-"
          ? { path: m[3] as string }
          : { path: m[3] as string, added: Number(m[1]), removed: Number(m[2]) },
      );
    out.push({ sha, subject, body, files });
  }
  return out;
}

/** A worktree of `root` at `commit` in a new temp folder, with node_modules and venvs linked. */
export async function taskWorktree(
  executor: Executor,
  root: string,
  commit: string,
): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "garuda-repo-task-")));
  await git(executor, root, ["worktree", "add", "--detach", "--quiet", dir, commit]);
  for (const name of LINK_CANDIDATES) {
    try {
      await symlink(join(root, name), join(dir, name), "dir");
    } catch {
      // Not in the checkout, or already there.
    }
  }
  return dir;
}

export async function removeTaskWorktree(
  executor: Executor,
  root: string,
  dir: string,
): Promise<void> {
  await git(executor, root, ["worktree", "remove", "--force", dir], { check: false });
  await rm(dir, { recursive: true, force: true });
  await git(executor, root, ["worktree", "prune"], { check: false });
}

/** Write (or delete) the task's test files into a worktree. */
export async function applyTests(
  dir: string,
  tests: readonly RepoTaskSpec["tests"][number][],
): Promise<void> {
  for (const t of tests) {
    const file = join(dir, t.path);
    if (t.content === null) await rm(file, { force: true });
    else {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, t.content);
    }
  }
}

/** Run the test command in a folder (on the host, as eval checks do). True when it passes. */
export async function testsPass(
  executor: Executor,
  dir: string,
  command: string,
): Promise<boolean> {
  const result = await executor.run(command, {
    root: dir,
    sandbox: false,
    writePaths: [dir],
    denyWritePaths: [],
    denyReadPaths: [],
    network: false,
    envAllowlist: [...DEFAULT_ENV_ALLOWLIST, ...TOOLCHAIN_ENV],
    timeoutMs: BUILD_TEST_TIMEOUT_MS,
    maxOutputBytes: 20_000,
  });
  return result.exitCode === 0 && !result.timedOut;
}

export interface BuildOptions {
  commits?: number;
  since?: string;
  maxTasks?: number;
  testCommand: string;
  onProgress?: (line: string) => void;
}

/**
 * Build the suite: each candidate must fail at its parent (with its tests added) and pass at the
 * commit. Stops at `maxTasks`. Returns the suite and the count of candidates checked.
 */
export async function buildRepoSuite(
  executor: Executor,
  root: string,
  options: BuildOptions,
): Promise<{ suite: RepoSuite; checked: number; skipped: Record<string, number> }> {
  const say = options.onProgress ?? (() => {});
  const head = (await git(executor, root, ["rev-parse", "HEAD"])).stdout.trim();
  const commits = await recentCommits(executor, root, {
    ...(options.commits === undefined ? {} : { commits: options.commits }),
    ...(options.since === undefined ? {} : { since: options.since }),
  });
  const skipped: Record<string, number> = {};
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };
  const tasks: RepoTaskSpec[] = [];
  let checked = 0;
  const max = options.maxTasks ?? DEFAULT_MAX_TASKS;
  for (const commit of commits) {
    if (tasks.length >= max) break;
    const why = skipReason(commit);
    if (why !== undefined) {
      skip(why);
      continue;
    }
    const parent = await git(
      executor,
      root,
      ["rev-parse", "--verify", "--quiet", `${commit.sha}^`],
      {
        check: false,
      },
    );
    if (parent.exitCode !== 0) {
      skip("the first commit (no parent)");
      continue;
    }
    const base = parent.stdout.trim();
    const testPaths = commit.files.filter((f) => TEST_PATH.test(f.path)).map((f) => f.path);
    const tests: RepoTaskSpec["tests"] = [];
    for (const path of testPaths) {
      const shown = await git(executor, root, ["show", `${commit.sha}:${path}`], { check: false });
      tests.push({ path, content: shown.exitCode === 0 ? shown.stdout : null });
    }
    checked++;
    say(`checking ${commit.sha.slice(0, 7)} ${commit.subject}`);
    const dir = await taskWorktree(executor, root, base);
    try {
      await applyTests(dir, tests);
      if (await testsPass(executor, dir, options.testCommand)) {
        skip("the tests already pass at the parent");
        continue;
      }
      await git(executor, dir, ["checkout", "--quiet", "--", "."], { check: false });
      await git(executor, dir, ["clean", "-fdq"], { check: false });
      await git(executor, dir, ["checkout", "--quiet", "--detach", commit.sha]);
      if (!(await testsPass(executor, dir, options.testCommand))) {
        skip("the tests fail at the commit");
        continue;
      }
    } finally {
      await removeTaskWorktree(executor, root, dir);
    }
    tasks.push({
      id: `repo-${commit.sha.slice(0, 7)}`,
      sha: commit.sha,
      base,
      subject: commit.subject,
      prompt: repoPrompt(commit, testPaths),
      tests,
    });
    say(`kept ${commit.sha.slice(0, 7)} (${tasks.length}/${max})`);
  }
  return {
    suite: {
      version: 1,
      root,
      head,
      createdAt: new Date().toISOString(),
      testCommand: options.testCommand,
      tasks,
    },
    checked,
    skipped,
  };
}

export async function saveRepoSuite(suite: RepoSuite): Promise<string> {
  const file = join(suite.root, REPO_SUITE_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(suite, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export async function loadRepoSuite(root: string): Promise<RepoSuite | undefined> {
  let text: string;
  try {
    text = await readFile(join(root, REPO_SUITE_FILE), "utf8");
  } catch {
    return undefined;
  }
  const parsed = suiteSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${REPO_SUITE_FILE}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** The suite's tasks for the eval runner: the worktree, the tests, the check, the protected files. */
export function repoEvalTasks(suite: RepoSuite): EvalTask[] {
  return suite.tasks.map((t) => ({
    id: t.id,
    title: t.subject,
    prompt: t.prompt,
    files: {},
    check: suite.testCommand,
    protect: t.tests.filter((f) => f.content !== null).map((f) => f.path),
    solution: {},
    repo: { root: suite.root, base: t.base, tests: t.tests },
  }));
}
