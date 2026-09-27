import { DEFAULT_ENV_ALLOWLIST } from "../permissions/engine.js";
import type { ExecPolicy, Executor } from "../sandbox/types.js";

/**
 * git for scheduled jobs (0.7): the job branch, its worktree and the final commit. git runs through
 * the Executor (N8), outside the sandbox (it writes the project's .git), with the user's own git
 * config (their name and email for the commit) but never the repository's hooks: a cloned repo's
 * hook would run outside the sandbox.
 */

const GIT_TIMEOUT_MS = 120_000;

export class JobGitError extends Error {}

/** One shell word. */
export function shellWord(text: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

export interface GitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run `git <args>` in `cwd`. Throws JobGitError on a non-zero exit unless `check` is false. */
export async function git(
  executor: Executor,
  cwd: string,
  args: readonly string[],
  options: { check?: boolean; signal?: AbortSignal } = {},
): Promise<GitResult> {
  const policy: ExecPolicy = {
    root: cwd,
    sandbox: false,
    writePaths: [],
    denyWritePaths: [],
    denyReadPaths: [],
    network: false,
    envAllowlist: [...DEFAULT_ENV_ALLOWLIST],
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: 5_000_000,
  };
  const command = ["git", "-c", "core.hooksPath=/dev/null", ...args].map(shellWord).join(" ");
  const result = await executor.run(command, policy, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.aborted) throw options.signal?.reason ?? new Error("stopped");
  const out = { exitCode: result.exitCode, stdout: result.stdout.text, stderr: result.stderr.text };
  if (options.check !== false && result.exitCode !== 0) {
    const why = (out.stderr || out.stdout).trim().split("\n").slice(-3).join(" ");
    throw new JobGitError(
      result.timedOut ? `git ${args[0]} took too long.` : `git ${args[0]} failed: ${why}`,
    );
  }
  return out;
}
