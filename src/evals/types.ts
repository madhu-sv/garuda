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
  /** Files that must stay as they were. Default: every file under test/. */
  protect?: string[];
  /**
   * Files that make the check pass. The unit tests use them to prove that each task
   * can pass, and that it fails before the fix.
   */
  solution: Record<string, string>;
}

export interface EvalResult {
  id: string;
  title: string;
  passed: boolean;
  /** Why it failed: the check output, a changed protected file, or an error. */
  reason?: string;
  stopReason: string;
  steps: number;
  tokens: number;
  costUsd: number | undefined;
  durationMs: number;
  sessionFile?: string;
}
