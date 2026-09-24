import { spawn } from "node:child_process";
import { OutputCapture } from "./capture.js";
import type { ExecOptions, ExecPolicy, ExecResult, Executor, Isolation } from "./types.js";

/** Time between SIGTERM and SIGKILL when the tree must stop. */
const KILL_GRACE_MS = 2_000;

/** The program to start for one command. */
export interface Launch {
  file: string;
  args: string[];
}

/**
 * The shared process runner. Subclasses only say how to launch a command.
 * It applies the working root, the environment allowlist, the timeout and the output cap.
 * The command runs in its own process group, so a timeout or Ctrl-C kills the whole tree.
 */
export abstract class ProcessExecutor implements Executor {
  abstract readonly name: string;
  abstract readonly isolation: Isolation;
  /** Process group ids of running commands. */
  private readonly running = new Set<number>();

  /** How to start `command` under `policy`. */
  protected abstract launch(command: string, policy: ExecPolicy): Launch;

  shutdown(): void {
    for (const pid of this.running) signalGroup(pid, "SIGKILL");
    this.running.clear();
  }

  run(command: string, policy: ExecPolicy, options: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    const stdout = new OutputCapture(policy.maxOutputBytes);
    const stderr = new OutputCapture(policy.maxOutputBytes);

    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(options.signal.reason);
        return;
      }

      const { file, args } = this.launch(command, policy);
      const child = spawn(file, args, {
        cwd: policy.root,
        env: allowedEnv(policy.envAllowlist),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      const pid = child.pid;
      if (pid !== undefined) this.running.add(pid);
      let timedOut = false;
      let aborted = false;
      let killTimer: NodeJS.Timeout | undefined;

      const killTree = () => {
        if (child.pid === undefined || child.exitCode !== null) return;
        signalGroup(child.pid, "SIGTERM");
        killTimer ??= setTimeout(() => {
          if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
        }, KILL_GRACE_MS);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, policy.timeoutMs);

      const onAbort = () => {
        aborted = true;
        killTree();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

      child.on("error", (error) => {
        if (pid !== undefined) this.running.delete(pid);
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });

      // "close" fires after the streams end, so all output is in.
      child.on("close", (code, signal) => {
        if (pid !== undefined) this.running.delete(pid);
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        // Background children may still hold the group. Stop them too.
        if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolve({
          exitCode: code,
          signal,
          stdout: stdout.result(),
          stderr: stderr.result(),
          timedOut,
          aborted,
          durationMs: Date.now() - started,
        });
      });
    });
  }
}

/** Send a signal to a process group. The group may already be gone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: nothing left to kill.
  }
}

/** Only allowlisted variables reach the command (N8), also on the host. */
export function allowedEnv(allowlist: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of allowlist) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Plain bash, with no isolation. */
export function plainBash(command: string): Launch {
  return { file: "bash", args: ["-c", command] };
}
