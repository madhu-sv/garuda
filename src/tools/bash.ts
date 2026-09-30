import { z } from "zod";
import { commandParts } from "../permissions/rules.js";
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
  outside_sandbox: z
    .boolean()
    .optional()
    .describe(
      "Run outside the sandbox, with network and writes anywhere. The user must approve. Use it only after the sandbox blocked the command.",
    ),
});

type Input = z.infer<typeof input>;

/** The command result plus short notes for the model about how it used bash. */
export type BashOutput = ExecResult & { hints: string[] };

/** Programs that only read files. A command made only of these should use the file tools. */
const READERS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "ls",
  "tree",
  "find",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "wc",
  "file",
  "stat",
]);

/**
 * Remove a leading `cd <working root> &&` (or `;`): every call already starts in the root.
 * Models often add it with the absolute path, which only makes the command longer.
 */
export function stripRootCd(command: string, root: string): { command: string; stripped: boolean } {
  const roots = new Set([root, `${root}/`, ".", "./", "$(pwd)", "$PWD", "`pwd`"]);
  let rest = command.trimStart();
  let stripped = false;
  for (;;) {
    const match = /^cd\s+("([^"]*)"|'([^']*)'|(\S+))\s*(&&|;)\s*/.exec(rest);
    const target = match?.[2] ?? match?.[3] ?? match?.[4];
    if (match === null || target === undefined || !roots.has(target)) break;
    rest = rest.slice(match[0].length);
    stripped = true;
  }
  return { command: stripped && rest !== "" ? rest : command, stripped: stripped && rest !== "" };
}

/** Errors that a sandbox block gives: no network, or a write outside the allowed paths. */
const SANDBOX_BLOCK =
  /Operation not permitted|Read-only file system|EROFS|EPERM|EAI_AGAIN|ENOTFOUND|ENETUNREACH|Network is unreachable|Could not resolve host|Temporary failure in name resolution|getaddrinfo/;

/** A note when a failed command in the sandbox looks blocked by it. */
export function sandboxHint(result: ExecResult, allowlist = false): string | undefined {
  if (result.exitCode === 0 || result.timedOut || result.aborted) return undefined;
  if (!SANDBOX_BLOCK.test(`${result.stdout.text}\n${result.stderr.text}`)) return undefined;
  const network = allowlist
    ? "it reaches only the hosts on the network allowlist, through Garuda's proxy"
    : "it has no network";
  return `The sandbox may have blocked this command: ${network}, and it can write only in the working root and temp folders. If the command must have more, run it again with outside_sandbox: true. The user must approve.`;
}

/** The network allowlist (0.13): a note that names the hosts the proxy blocked. */
export function networkHint(
  blocked: readonly { host: string; port: number; reason: string }[],
): string | undefined {
  if (blocked.length === 0) return undefined;
  const seen = [...new Map(blocked.map((b) => [`${b.host}:${b.port}`, b.reason])).values()];
  return `${seen.join(" ")} Commands in the sandbox reach only the hosts on the network allowlist. Do not work around it; if the host is needed, tell the user: they can add it to "network.allow" in .garuda/settings.json, or approve outside_sandbox: true.`;
}

/** Notes for the model about the command it ran (see the system prompt for the same rules). */
export function commandHints(command: string, strippedCd: boolean): string[] {
  const hints: string[] = [];
  const programs = commandParts(command).map((part) => part.split(" ")[0] ?? "");
  if (strippedCd) {
    hints.push(
      "Garuda removed the leading `cd` to the working root: every bash call already starts there.",
    );
  }
  if (programs.length > 0 && programs.every((p) => READERS.has(p))) {
    hints.push(
      "This command only reads files. Use read_file, glob and grep for that: they need no approval, and edit_file accepts only files that read_file has read.",
    );
  } else if (programs.slice(1).some((p) => p === "head" || p === "tail")) {
    hints.push(
      "The exit code above comes from head or tail, not from your command. Do not pipe into them: Garuda already cuts long output.",
    );
  }
  return hints;
}

/** bash (F14): run a command through the Executor (N8). */
export const bashTool: Tool<Input, BashOutput> = {
  name: "bash",
  description: [
    "Run a bash command. Each call starts in the working root; cd does not carry over to the next call.",
    `The default timeout is ${BASH_DEFAULT_TIMEOUT_MS / 1000} s. A timeout kills the command and its child processes.`,
    "The command gets no input (stdin is closed). Do not start interactive programs.",
    "Long output is cut in the middle. The result shows the exit code, stdout and stderr.",
    "Use read_file, glob and grep to look at files, not cat, ls, find or grep: they need no approval.",
    "Do not pipe into tail or head: the pipe hides the exit code, and long output is cut already.",
    "When Garuda has an OS sandbox, commands run in it with no approval: no network (or only the hosts on the user's network allowlist), writes only in the working root and temp folders.",
    "Otherwise the user must approve each command.",
  ].join("\n"),
  inputSchema: input,
  readOnly: false,
  runsCommands: true,

  // The user approves, and rules match, the command that will really run.
  async describe({ command, outside_sandbox }, { root, executor }) {
    const run = stripRootCd(command, root).command;
    const outside = outside_sandbox === true && executor?.isolation !== "none";
    return {
      target: { kind: "command", command: run, ...(outside ? { outsideSandbox: true } : {}) },
      preview: run,
    };
  },

  async run({ command, timeout_ms, outside_sandbox }, { executor, permissions, signal, root }) {
    if (executor === undefined) throw new Error("No executor is configured, so bash cannot run.");
    const sandboxed = executor.isolation !== "none" && outside_sandbox !== true;
    const policy = permissions.execPolicy(timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS, {
      sandbox: sandboxed,
    });
    const { command: run, stripped } = stripRootCd(command, root);
    permissions.takeNetworkBlocks?.();
    const result = await executor.run(run, policy, { signal });
    const hints = commandHints(run, stripped);
    const network = sandboxed ? networkHint(permissions.takeNetworkBlocks?.() ?? []) : undefined;
    if (network !== undefined) hints.push(network);
    const blocked =
      sandboxed && network === undefined
        ? sandboxHint(result, policy.proxy !== undefined)
        : undefined;
    if (blocked !== undefined) hints.push(blocked);
    return { ...result, hints };
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
    for (const hint of result.hints) lines.push(`[Garuda: ${hint}]`);
    return lines.join("\n");
  },
};
