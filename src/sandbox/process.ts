import { spawn } from "node:child_process";
import { OutputCapture } from "./capture.js";
import { DaemonManager } from "./daemon.js";
import type { Tracker } from "./reaper.js";
import type {
  ExecOptions,
  ExecPolicy,
  ExecResult,
  Executor,
  Isolation,
  RunningProcess,
} from "./types.js";

/** Time between SIGTERM and SIGKILL when the tree must stop. */
const KILL_GRACE_MS = 2_000;

/** After the command's own process exits, the longest wait for its output pipes to close. */
export const EXIT_DRAIN_MS = 2_000;

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
  /** Manages background daemon processes (0.14). */
  readonly daemons: DaemonManager = new DaemonManager(this);
  /** Process group ids of running commands. */
  private readonly running = new Set<number>();
  /** Markers of commands and processes that still run (0.17, IPI-04): shutdown() reaps them. */
  private readonly trackers = new Set<Tracker>();

  /** How to start the program `argv` under `policy`, with the tracker's profile rules. */
  protected abstract launch(argv: string[], policy: ExecPolicy, tracker?: Tracker): Launch;

  /**
   * Markers for one command, when this executor can find the processes that leave its process
   * group (Seatbelt with the helper). Others need none: bubblewrap's PID namespace ends them all.
   */
  protected track(_policy: ExecPolicy): Tracker | undefined {
    return undefined;
  }

  /** Remove what tracking keeps (the markers folder), at shutdown. */
  protected closeTracking(): void {}

  shutdown(): void {
    this.daemons.shutdown();
    for (const pid of this.running) signalGroup(pid, "SIGKILL");
    this.running.clear();
    for (const tracker of this.trackers) {
      try {
        tracker.reapSync();
      } catch {
        // The helper failed or a marker is gone: nothing more to do at exit.
      }
    }
    this.trackers.clear();
    this.closeTracking();
  }

  /** The launch, with markers; the markers go away when the launch fails. */
  private launchTracked(argv: string[], policy: ExecPolicy): Launch & { tracker?: Tracker } {
    const tracker = this.track(policy);
    try {
      const launch = this.launch(argv, policy, tracker);
      if (tracker === undefined) return launch;
      this.trackers.add(tracker);
      return { ...launch, tracker };
    } catch (error) {
      tracker?.dispose();
      throw error;
    }
  }

  /** Kill the tracked processes that still run (the command's own group is already gone). */
  private async reap(tracker: Tracker): Promise<{ reaped?: number; reapProblem?: string }> {
    try {
      const n = await tracker.reap();
      return n > 0 ? { reaped: n } : {};
    } catch (error) {
      return { reapProblem: (error as Error).message };
    } finally {
      this.trackers.delete(tracker);
    }
  }

  private dropTracker(tracker: Tracker | undefined): void {
    if (tracker === undefined || !this.trackers.delete(tracker)) return;
    tracker.dispose();
  }

  start(argv: string[], policy: ExecPolicy, env: Record<string, string> = {}): RunningProcess {
    const { file, args, tracker } = this.launchTracked(argv, policy);
    const child = spawn(file, args, {
      cwd: policy.root,
      env: { ...allowedEnv(policy.envAllowlist), ...proxyEnv(policy), ...env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const pid = child.pid;
    if (pid !== undefined) this.running.add(pid);
    let killTimer: NodeJS.Timeout | undefined;
    child.on("exit", () => {
      if (pid !== undefined) {
        this.running.delete(pid);
        // Children that the program started may still hold the group.
        signalGroup(pid, "SIGKILL");
      }
      if (killTimer !== undefined) clearTimeout(killTimer);
      // And processes that left the group (macOS, IPI-04).
      if (tracker !== undefined) void this.reap(tracker);
    });
    child.on("error", () => this.dropTracker(tracker));
    return {
      pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      stop: () => {
        if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
        signalGroup(pid, "SIGTERM");
        killTimer ??= setTimeout(() => signalGroup(pid, "SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      },
      onExit: (listener) => {
        child.on("exit", (code, signal) => listener(code, signal));
      },
      onError: (listener) => {
        child.on("error", listener);
      },
    };
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

      const { file, args, tracker } = this.launchTracked(["bash", "-c", command], policy);
      const child = spawn(file, args, {
        cwd: policy.root,
        env: { ...allowedEnv(policy.envAllowlist), ...proxyEnv(policy), ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      const pid = child.pid;
      if (pid !== undefined) this.running.add(pid);
      let timedOut = false;
      let aborted = false;
      let finished = false;
      let killTimer: NodeJS.Timeout | undefined;
      let drainTimer: NodeJS.Timeout | undefined;

      // The group is signalled even when bash itself has already exited: a background child
      // started by the command may still be running in it.
      const killTree = () => {
        if (child.pid === undefined || finished) return;
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
        if (finished) return;
        finished = true;
        this.dropTracker(tracker);
        if (pid !== undefined) this.running.delete(pid);
        clearTimeout(timer);
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });

      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (finished) return;
        finished = true;
        if (pid !== undefined) this.running.delete(pid);
        clearTimeout(timer);
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", onAbort);
        // Background children may still hold the group. Stop them too.
        if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
        const result: ExecResult = {
          exitCode: code,
          signal,
          stdout: stdout.result(),
          stderr: stderr.result(),
          timedOut,
          aborted,
          durationMs: Date.now() - started,
        };
        if (tracker === undefined) {
          resolve(result);
          return;
        }
        // Processes that left the group (macOS, IPI-04): the helper finds them by their profile.
        void this.reap(tracker).then((reaped) => resolve({ ...result, ...reaped }));
      };

      // When the command's own process exits, the output normally ends at once. A background
      // child that inherited the pipes keeps them open, and "close" never came (0.14, review): the
      // call hung past its timeout and Ctrl-C. So wait at most EXIT_DRAIN_MS for the pipes, then
      // stop the group, close the pipes and return what was captured.
      child.on("exit", (code, signal) => {
        drainTimer = setTimeout(() => {
          if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
          finish(code, signal);
        }, EXIT_DRAIN_MS);
      });

      // "close" fires after the streams end, so all output is in.
      child.on("close", (code, signal) => finish(code, signal));
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

/**
 * The proxy variables for a sandboxed command (0.13). Most tools read HTTP(S)_PROXY: npm, pip,
 * cargo, go, git, curl; Node's fetch with NODE_USE_ENV_PROXY; Maven and Gradle through their
 * Java options.
 */
export function proxyEnv(
  policy: ExecPolicy,
  // The allowlisted environment (0.14, review): MAVEN_OPTS/GRADLE_OPTS were read from the full
  // process.env, so a value outside the allowlist (a proxy password) reached the command.
  base: Record<string, string> = allowedEnv(policy.envAllowlist),
): Record<string, string> {
  if (!policy.sandbox || policy.network || policy.proxy === undefined) return {};
  const url = `http://127.0.0.1:${policy.proxy.port}`;
  const java = `-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=${policy.proxy.port} -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=${policy.proxy.port}`;
  const add = (name: string) => `${base[name] === undefined ? "" : `${base[name]} `}${java}`;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    NODE_USE_ENV_PROXY: "1",
    MAVEN_OPTS: add("MAVEN_OPTS"),
    GRADLE_OPTS: add("GRADLE_OPTS"),
  };
}

/** The program itself, with no isolation. */
export function plain(argv: string[]): Launch {
  const [file = "", ...args] = argv;
  return { file, args };
}
