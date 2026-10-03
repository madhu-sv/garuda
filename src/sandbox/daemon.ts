import type { ExecPolicy, Executor, RunningProcess } from "./types.js";

export type DaemonStatus = "running" | "stopped" | "failed";

export interface DaemonInfo {
  readonly id: string;
  readonly pid: number | undefined;
  readonly command: string;
  readonly status: DaemonStatus;
  readonly startTime: number;
  readonly endTime?: number | undefined;
  readonly uptimeMs: number;
  readonly exitCode?: number | null | undefined;
  readonly signal?: string | null | undefined;
}

export interface DaemonSpawnOptions {
  env?: Record<string, string> | undefined;
  maxBufferLines?: number | undefined;
}

export interface DaemonLogEntry {
  readonly timestamp: number;
  readonly stream: "stdout" | "stderr";
  readonly line: string;
}

interface DaemonEntry {
  readonly info: {
    id: string;
    pid: number | undefined;
    command: string;
    startTime: number;
    endTime?: number | undefined;
    status: DaemonStatus;
    exitCode?: number | null | undefined;
    signal?: string | null | undefined;
  };
  readonly process: RunningProcess;
  readonly logs: DaemonLogEntry[];
  readonly maxBufferLines: number;
  stdoutRemainder: string;
  stderrRemainder: string;
  /** The user asked to stop it (kill or shutdown): its exit counts as "stopped", whatever the code. */
  stopRequested: boolean;
}

export const DEFAULT_MAX_LOG_LINES = 2_000;
/** Longest kept line; a longer one is cut (merge gate: memory had no limit). */
export const MAX_LOG_LINE_CHARS = 4_000;
/** Most text kept while no newline comes (progress bars with \r, binary output). */
export const MAX_PENDING_CHARS = 64_000;
/** Most characters that `logs` returns at once (into the model's context). */
export const MAX_LOGS_CHARS = 30_000;

const cut = (line: string) =>
  line.length <= MAX_LOG_LINE_CHARS
    ? line
    : `${line.slice(0, MAX_LOG_LINE_CHARS)}… [${line.length - MAX_LOG_LINE_CHARS} more chars]`;

export class DaemonManager {
  private nextId = 1;
  private readonly daemons = new Map<string, DaemonEntry>();

  constructor(private readonly executor: Executor) {}

  spawn(command: string, policy: ExecPolicy, options: DaemonSpawnOptions = {}): DaemonInfo {
    const id = `daemon_${this.nextId++}`;
    const maxBufferLines = options.maxBufferLines ?? DEFAULT_MAX_LOG_LINES;

    const process = this.executor.start(["bash", "-c", command], policy, options.env);
    // Daemons get no stdin; close immediately so processes waiting on EOF do not hang.
    process.stdin.end();

    const entry: DaemonEntry = {
      info: {
        id,
        pid: process.pid,
        command,
        startTime: Date.now(),
        status: "running",
      },
      process,
      logs: [],
      maxBufferLines,
      stdoutRemainder: "",
      stderrRemainder: "",
      stopRequested: false,
    };

    const appendChunk = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const text =
        (stream === "stdout" ? entry.stdoutRemainder : entry.stderrRemainder) +
        chunk.toString("utf8");
      const lines = text.split("\n");
      let remainder = lines.pop() ?? "";
      // No newline for a long time: keep it as a (cut) line, so memory stays bounded.
      if (remainder.length > MAX_PENDING_CHARS) {
        lines.push(remainder);
        remainder = "";
      }
      if (stream === "stdout") entry.stdoutRemainder = remainder;
      else entry.stderrRemainder = remainder;

      const now = Date.now();
      for (const line of lines) {
        if (entry.logs.length >= entry.maxBufferLines) {
          entry.logs.shift();
        }
        entry.logs.push({ timestamp: now, stream, line: cut(line) });
      }
    };

    process.stdout.on("data", (chunk: Buffer) => appendChunk(chunk, "stdout"));
    process.stderr.on("data", (chunk: Buffer) => appendChunk(chunk, "stderr"));

    process.onExit((code, signal) => {
      // Flush any remainders
      if (entry.stdoutRemainder.length > 0) {
        if (entry.logs.length >= entry.maxBufferLines) entry.logs.shift();
        entry.logs.push({
          timestamp: Date.now(),
          stream: "stdout",
          line: cut(entry.stdoutRemainder),
        });
        entry.stdoutRemainder = "";
      }
      if (entry.stderrRemainder.length > 0) {
        if (entry.logs.length >= entry.maxBufferLines) entry.logs.shift();
        entry.logs.push({
          timestamp: Date.now(),
          stream: "stderr",
          line: cut(entry.stderrRemainder),
        });
        entry.stderrRemainder = "";
      }

      entry.info.endTime = Date.now();
      entry.info.exitCode = code;
      entry.info.signal = signal;
      if (entry.stopRequested || signal !== null || code === 0) {
        entry.info.status = "stopped";
      } else {
        entry.info.status = "failed";
      }
    });

    process.onError((error) => {
      if (entry.logs.length >= entry.maxBufferLines) entry.logs.shift();
      entry.logs.push({
        timestamp: Date.now(),
        stream: "stderr",
        line: `Process error: ${error.message}`,
      });
      entry.info.endTime = Date.now();
      entry.info.status = "failed";
    });

    this.daemons.set(id, entry);
    return this.toInfo(entry);
  }

  list(): DaemonInfo[] {
    return [...this.daemons.values()].map((entry) => this.toInfo(entry));
  }

  get(id: string): DaemonInfo | undefined {
    const entry = this.daemons.get(id);
    return entry ? this.toInfo(entry) : undefined;
  }

  logs(
    id: string,
    options: { lines?: number | undefined; stream?: "all" | "stdout" | "stderr" | undefined } = {},
  ): string[] | undefined {
    const entry = this.daemons.get(id);
    if (!entry) return undefined;

    const stream = options.stream ?? "all";
    const filtered =
      stream === "all" ? entry.logs : entry.logs.filter((log) => log.stream === stream);

    const limit = options.lines ?? 50;
    const sliced = limit <= 0 ? filtered : filtered.slice(-limit);
    // Newest lines win when the total is too long for the model's context.
    const out: string[] = [];
    let size = 0;
    for (const log of [...sliced].reverse()) {
      const line = `[${log.stream}] ${log.line}`;
      if (size + line.length > MAX_LOGS_CHARS) {
        out.push(`[garuda] … ${sliced.length - out.length} older line(s) left out`);
        break;
      }
      size += line.length + 1;
      out.push(line);
    }
    return out.reverse();
  }

  kill(id: string): { ok: boolean; message: string } {
    const entry = this.daemons.get(id);
    if (!entry) {
      return { ok: false, message: `Daemon process not found: ${id}` };
    }

    if (entry.info.status !== "running") {
      return {
        ok: true,
        message: `Daemon process ${id} was already ${entry.info.status} (exit code: ${entry.info.exitCode ?? "none"}).`,
      };
    }

    // The status changes when the process has really ended (0.14, review): before, it said
    // "stopped" at once, while the process could still run, and later flipped to "failed".
    entry.stopRequested = true;
    entry.process.stop();
    return {
      ok: true,
      message: `Asked daemon process ${id} (pid: ${entry.info.pid ?? "unknown"}) to stop: SIGTERM now, SIGKILL after 2 s if it is still running.`,
    };
  }

  shutdown(): void {
    for (const entry of this.daemons.values()) {
      if (entry.info.status === "running") {
        try {
          entry.stopRequested = true;
          entry.process.stop();
          entry.info.status = "stopped";
          entry.info.endTime = Date.now();
        } catch {
          // Process might already be stopped
        }
      }
    }
  }

  private toInfo(entry: DaemonEntry): DaemonInfo {
    const { id, pid, command, status, startTime, endTime, exitCode, signal } = entry.info;
    const uptimeMs = (endTime ?? Date.now()) - startTime;
    return {
      id,
      pid,
      command,
      status,
      startTime,
      endTime,
      uptimeMs,
      exitCode,
      signal,
    };
  }
}
