import { z } from "zod";
import type { ExecResult } from "../sandbox/types.js";
import type { Tool } from "./types.js";

export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;

const input = z.object({
  command: z.string().min(1).describe("The bash command to run."),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(BASH_MAX_TIMEOUT_MS)
    .optional()
    .describe(`Timeout in milliseconds. Default: ${BASH_DEFAULT_TIMEOUT_MS}.`),
});

type Input = z.infer<typeof input>;

/** bash (F14): run a command through the Executor (N8). */
export const bashTool: Tool<Input, ExecResult> = {
  name: "bash",
  description: [
    "Run a bash command. Each call starts in the working root; cd does not carry over to the next call.",
    `The default timeout is ${BASH_DEFAULT_TIMEOUT_MS / 1000} s. A timeout kills the command and its child processes.`,
    "The command gets no input (stdin is closed). Do not start interactive programs.",
    "Long output is cut in the middle. The result shows the exit code, stdout and stderr.",
    "Use read_file, glob and grep to look at files, not cat, find or grep.",
    "The user must approve each command.",
  ].join("\n"),
  inputSchema: input,
  readOnly: false,

  async describe({ command }) {
    return { target: { kind: "command", command }, preview: command };
  },

  async run({ command, timeout_ms }, { executor, permissions, signal }) {
    if (executor === undefined) throw new Error("No executor is configured, so bash cannot run.");
    const policy = permissions.execPolicy(timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS);
    return executor.run(command, policy, { signal });
  },

  toText(result) {
    const lines: string[] = [];
    if (result.timedOut) lines.push("The command timed out and was killed.");
    else if (result.aborted) lines.push("The command was stopped by the user.");
    lines.push(
      result.exitCode === null
        ? `Exit: killed by ${result.signal ?? "a signal"}`
        : `Exit code: ${result.exitCode}`,
    );
    for (const [name, output] of [
      ["stdout", result.stdout],
      ["stderr", result.stderr],
    ] as const) {
      if (output.totalBytes === 0) continue;
      const note = output.truncated ? ` (truncated: ${output.totalBytes} bytes in total)` : "";
      lines.push(`<${name}${note}>\n${output.text.replace(/\n$/, "")}\n</${name}>`);
    }
    if (result.stdout.totalBytes === 0 && result.stderr.totalBytes === 0) lines.push("(no output)");
    return lines.join("\n");
  },
};
