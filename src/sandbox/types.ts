/**
 * The Executor contract (N8). Only src/sandbox/ starts processes.
 * 0.1 ships HostExecutor (no isolation). 0.2 adds an OS sandbox with the same contract,
 * so the loop, the tools and the permission engine do not change.
 */

/** How strongly an executor enforces its policy. The permission engine reads this. */
export type Isolation = "none" | "os" | "container";

/**
 * What one command may do. The permission engine builds it.
 * HostExecutor applies `root`, `envAllowlist`, `timeoutMs` and `maxOutputBytes`.
 * It does not enforce `readPaths`, `writePaths` or `network`. A sandbox does.
 */
export interface ExecPolicy {
  /** Absolute working root. The command starts here. */
  root: string;
  readPaths: string[];
  writePaths: string[];
  network: boolean;
  /** Names of environment variables the command may see. All others are removed. */
  envAllowlist: string[];
  timeoutMs: number;
  /** Cap per stream (stdout, stderr). Output past the cap is cut from the middle. */
  maxOutputBytes: number;
}

export interface CapturedOutput {
  text: string;
  /** True when output was cut to fit the cap. */
  truncated: boolean;
  /** Bytes the command wrote to this stream in total. */
  totalBytes: number;
}

export interface ExecResult {
  /** null when a signal ended the process. */
  exitCode: number | null;
  /** The signal that ended the process, if any. */
  signal: string | null;
  stdout: CapturedOutput;
  stderr: CapturedOutput;
  timedOut: boolean;
  /** True when the caller aborted (Ctrl-C) and the process tree was killed. */
  aborted: boolean;
  durationMs: number;
}

export interface ExecOptions {
  signal?: AbortSignal;
}

export interface Executor {
  /** Config value that selects this executor, for example "host". */
  readonly name: string;
  readonly isolation: Isolation;
  /** Run `command` with bash. Never throws for a failed command: check exitCode. */
  run(command: string, policy: ExecPolicy, options?: ExecOptions): Promise<ExecResult>;
}
