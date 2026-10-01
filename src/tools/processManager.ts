import { z } from "zod";
import type { DaemonInfo } from "../sandbox/types.js";
import type { Tool } from "./types.js";

const input = z.object({
  action: z
    .enum(["list", "logs", "kill", "status"])
    .describe(
      "The action to perform: 'list' (all background processes), 'logs' (tail output), 'kill' (terminate a process), or 'status' (process details).",
    ),
  daemonId: z
    .string()
    .optional()
    .describe("The daemon ID (e.g. 'daemon_1'). Required for 'logs', 'kill', and 'status'."),
  lines: z
    .number()
    .int()
    .min(1)
    .max(1_000)
    .optional()
    .describe("Number of recent log lines to retrieve (default: 50). Only applicable to 'logs'."),
  stream: z
    .enum(["all", "stdout", "stderr"])
    .optional()
    .describe(
      "Filter logs by stream: 'all' (default), 'stdout', or 'stderr'. Only applicable to 'logs'.",
    ),
});

type Input = z.infer<typeof input>;

export interface ProcessManagerOutput {
  action: "list" | "logs" | "kill" | "status";
  text: string;
  daemons?: DaemonInfo[];
  daemon?: DaemonInfo;
  logLines?: string[];
}

export const processManagerTool: Tool<Input, ProcessManagerOutput> = {
  name: "process_manager",
  description: [
    "Inspect and manage background daemon processes started with bash(is_daemon: true).",
    "Actions:",
    "  - list: List all background processes with their ID, PID, status, uptime and command.",
    "  - logs: Tail recent stdout/stderr output for a daemon process.",
    "  - status: View detailed execution state and exit code of a daemon process.",
    "  - kill: Terminate a running daemon process.",
  ].join("\n"),
  inputSchema: input,
  readOnly: true,

  async run({ action, daemonId, lines, stream }, { executor }) {
    if (executor?.daemons === undefined) {
      return {
        action,
        text: "The current executor does not support background daemon processes.",
      };
    }

    const daemons = executor.daemons;

    if (action === "list") {
      const list = daemons.list();
      if (list.length === 0) {
        return {
          action,
          text: "No background daemon processes have been started in this session.",
          daemons: [],
        };
      }
      const formatted = list
        .map((d) => {
          const uptimeSec = (d.uptimeMs / 1000).toFixed(1);
          const pid = d.pid !== undefined ? `pid: ${d.pid}` : "pid: none";
          const exitInfo =
            d.exitCode !== undefined && d.exitCode !== null
              ? ` (exit: ${d.exitCode})`
              : d.signal
                ? ` (signal: ${d.signal})`
                : "";
          return `[${d.id}] ${d.status}${exitInfo} | ${pid} | uptime: ${uptimeSec}s | ${d.command}`;
        })
        .join("\n");
      return { action, text: formatted, daemons: list };
    }

    if (action === "logs") {
      if (!daemonId) {
        return { action, text: "Error: daemonId is required for action 'logs'." };
      }
      const logs = daemons.logs(daemonId, { lines, stream });
      if (logs === undefined) {
        return { action, text: `No daemon process found with ID "${daemonId}".` };
      }
      if (logs.length === 0) {
        return { action, text: `(no logs recorded yet for ${daemonId})`, logLines: [] };
      }
      return { action, text: logs.join("\n"), logLines: logs };
    }

    if (action === "status") {
      if (!daemonId) {
        return { action, text: "Error: daemonId is required for action 'status'." };
      }
      const d = daemons.get(daemonId);
      if (d === undefined) {
        return { action, text: `No daemon process found with ID "${daemonId}".` };
      }
      const uptimeSec = (d.uptimeMs / 1000).toFixed(1);
      const linesOut = [
        `Daemon ID: ${d.id}`,
        `Command: ${d.command}`,
        `PID: ${d.pid ?? "none"}`,
        `Status: ${d.status}`,
        `Started: ${new Date(d.startTime).toISOString()}`,
        `Uptime: ${uptimeSec} s`,
      ];
      if (d.endTime !== undefined) {
        linesOut.push(`Ended: ${new Date(d.endTime).toISOString()}`);
      }
      if (d.exitCode !== undefined && d.exitCode !== null) {
        linesOut.push(`Exit Code: ${d.exitCode}`);
      }
      if (d.signal) {
        linesOut.push(`Signal: ${d.signal}`);
      }
      return { action, text: linesOut.join("\n"), daemon: d };
    }

    if (action === "kill") {
      if (!daemonId) {
        return { action, text: "Error: daemonId is required for action 'kill'." };
      }
      const outcome = daemons.kill(daemonId);
      return { action, text: outcome.message };
    }

    return { action, text: `Unknown action: ${action}` };
  },

  toText(result) {
    return result.text;
  },
};
