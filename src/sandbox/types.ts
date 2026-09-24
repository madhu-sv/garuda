/**
 * The Executor contract (N8). Only src/sandbox/ starts processes.
 * HostExecutor has no isolation. SeatbeltExecutor (macOS) and BwrapExecutor (Linux) are the
 * OS sandbox (0.2). All pass the same contract tests.
 */

/** How strongly an executor enforces its policy. The permission engine reads this. */
export type Isolation = "none" | "os" | "container";

/**
 * What one command may do. The permission engine builds it.
 * All executors apply `root`, `envAllowlist`, `timeoutMs` and `maxOutputBytes`.
 * An OS sandbox also enforces the file and network rules, when `sandbox` is true.
 * Reads are allowed everywhere except `denyReadPaths` (0.2 decision: writes-only scope).
 */
export interface ExecPolicy {
  /** Absolute working root. The command starts here. */
  root: string;
  /** False when the user approved a run outside the sandbox. The executor then isolates nothing. */
  sandbox: boolean;
  /** Absolute paths the command may write (the root, temp folders, tool caches). */
  writePaths: string[];
  /** Absolute paths inside `writePaths` that stay read-only, for example <root>/.git/hooks. */
  denyWritePaths: string[];
  /** Absolute paths the command may not read, for example ~/.ssh. */
  denyReadPaths: string[];
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
  /** Variables added on top of the allowlist (hooks pass their event data this way). */
  env?: Record<string, string>;
}

/** A long-running program with pipes, for example an MCP server over stdio. */
export interface RunningProcess {
  readonly pid: number | undefined;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  /** Stop the process group: SIGTERM, then SIGKILL after a grace time. */
  stop(): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface Executor {
  /** Config value that selects this executor, for example "host". */
  readonly name: string;
  readonly isolation: Isolation;
  /** Run `command` with bash. Never throws for a failed command: check exitCode. */
  run(command: string, policy: ExecPolicy, options?: ExecOptions): Promise<ExecResult>;
  /**
   * Start `argv` (no shell) under `policy`, with pipes on stdin, stdout and stderr.
   * `env` adds variables on top of the allowlist. `timeoutMs` and `maxOutputBytes` do not apply.
   * shutdown() stops it too.
   */
  start(argv: string[], policy: ExecPolicy, env?: Record<string, string>): RunningProcess;
  /**
   * Kill every running command now, with no grace time (F4). Garuda calls it when it exits,
   * so no orphan process stays. It must be synchronous: it runs in the process "exit" handler.
   */
  shutdown(): void;
}
