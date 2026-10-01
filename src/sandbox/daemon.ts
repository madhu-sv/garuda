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
}

export const DEFAULT_MAX_LOG_LINES = 2_000;

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
    };

    const appendChunk = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const text =
        (stream === "stdout" ? entry.stdoutRemainder : entry.stderrRemainder) +
        chunk.toString("utf8");
      const lines = text.split("\n");
      const remainder = lines.pop() ?? "";
      if (stream === "stdout") entry.stdoutRemainder = remainder;
      else entry.stderrRemainder = remainder;

      const now = Date.now();
      for (const line of lines) {
        if (entry.logs.length >= entry.maxBufferLines) {
          entry.logs.shift();
        }
        entry.logs.push({ timestamp: now, stream, line });
      }
    };

    process.stdout.on("data", (chunk: Buffer) => appendChunk(chunk, "stdout"));
    process.stderr.on("data", (chunk: Buffer) => appendChunk(chunk, "stderr"));

    process.onExit((code, signal) => {
      // Flush any remainders
      if (entry.stdoutRemainder.length > 0) {
        if (entry.logs.length >= entry.maxBufferLines) entry.logs.shift();
        entry.logs.push({ timestamp: Date.now(), stream: "stdout", line: entry.stdoutRemainder });
        entry.stdoutRemainder = "";
      }
      if (entry.stderrRemainder.length > 0) {
        if (entry.logs.length >= entry.maxBufferLines) entry.logs.shift();
        entry.logs.push({ timestamp: Date.now(), stream: "stderr", line: entry.stderrRemainder });
        entry.stderrRemainder = "";
      }

      entry.info.endTime = Date.now();
      entry.info.exitCode = code;
      entry.info.signal = signal;
      if (signal !== null || code === 0) {
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
    return sliced.map((log) => `[${log.stream}] ${log.line}`);
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

    entry.process.stop();
    entry.info.status = "stopped";
    entry.info.endTime = Date.now();
    return {
      ok: true,
      message: `Terminated daemon process ${id} (pid: ${entry.info.pid ?? "unknown"}).`,
    };
  }

  shutdown(): void {
    for (const entry of this.daemons.values()) {
      if (entry.info.status === "running") {
        try {
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
