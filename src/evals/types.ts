import type { ToolchainId } from "./toolchains.js";

/**
 * An eval task (N5): a small repo, a prompt, and a check.
 * The runner writes `files` into a scratch folder, gives the agent `prompt`,
 * and then runs `check`. The task passes when the check exits with 0
 * and no file in `protect` changed (so the agent cannot pass by editing the tests).
 */
export interface EvalTask {
  id: string;
  title: string;
  prompt: string;
  files: Record<string, string>;
  /** A shell command, run in the scratch folder after the agent stops. */
  check: string;
  /**
   * Files that must stay as they were. Default: tests (test/, tests/, src/test/) and build files
   * (pom.xml, pyproject.toml).
   */
  protect?: string[];
  /** Toolchains that the check needs (0.3). The task runs only when they work on this machine. */
  requires?: ToolchainId[];
  /**
   * Files that make the check pass. The unit tests use them to prove that each task
   * can pass, and that it fails before the fix.
   */
  solution: Record<string, string>;
  /**
   * Globs of files that the task may change besides its solution files (0.17, T11a), for example
   * `src/**` for a task that may touch any source file. A change outside both is "unexpected".
   */
  allowChanges?: string[];
  /**
   * A task from the project's own history (0.12, "benchmark your repo"). The runner makes a git
   * worktree of `root` at `base` in place of writing `files`, then adds the commit's tests
   * (`content: null` deletes the file).
   */
  repo?: {
    root: string;
    base: string;
    /** The real commit (0.17): its changed files are the task's expected files. */
    sha?: string;
    tests: { path: string; content: string | null }[];
  };
}

export interface EvalResult {
  id: string;
  title: string;
  passed: boolean;
  /** Why it failed: the check output, a changed protected file, or an error. */
  reason?: string;
  stopReason: string;
  steps: number;
  /** Provider-reported tokens; incomplete when `unreportedTokens` is nonzero. */
  tokens: number;
  /** Full reservations charged without provider-reported usage. Kept apart from `tokens`. */
  unreportedTokens?: number;
  costUsd: number | undefined;
  /** The run had spending with no known cost: `costUsd` is a minimum (review of 1370184). */
  costIncomplete?: boolean;
  durationMs: number;
  /** Tokens read from the prompt cache (0.7: to compare the Batch API's cache hits). */
  cacheReadTokens?: number;
  sessionFile?: string;
  /** 1, 2, 3 … for the repeats of one task, in run order (0.17, T11a). */
  attempt?: number;
  /**
   * Files that the run added, changed or deleted (0.17, T11a), relative to the task's start
   * state; Garuda's folder, git's data and build output left out.
   */
  changed?: string[];
  /** The changed files that the task did not need. Absent when its expected files are unknown. */
  unexpected?: string[];
}
