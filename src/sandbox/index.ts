import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { BwrapExecutor } from "./bwrap.js";
import { HostExecutor } from "./host.js";
import { SANDBOX_EXEC, SeatbeltExecutor } from "./seatbelt.js";
import type { Executor } from "./types.js";

export type { ExecPolicy, ExecResult, Executor, Isolation } from "./types.js";

/**
 * Executor names that the config key `executor` accepts (N8):
 *   auto  the OS sandbox when this machine has one, else host with a notice (default)
 *   os    the OS sandbox, or an error
 *   host  no sandbox: every command asks for approval
 */
export const EXECUTOR_NAMES = ["auto", "os", "host"] as const;
export type ExecutorName = (typeof EXECUTOR_NAMES)[number];

export interface ExecutorChoice {
  executor: Executor;
  /** Set when "auto" found no sandbox. The CLI shows it. */
  notice?: string;
}

/** One config key picks the executor (N8). The loop receives the result as a dependency. */
export function createExecutor(
  name: ExecutorName = "auto",
  find: () => OsSandbox = findOsSandbox,
): ExecutorChoice {
  if (name === "host") return { executor: new HostExecutor() };
  const found = find();
  if ("executor" in found) return { executor: found.executor };
  if (name === "os") throw new Error(`No OS sandbox: ${found.problem} ${found.fix}`);
  return {
    executor: new HostExecutor(),
    notice: `No OS sandbox: ${found.problem} Commands run on your machine, and each one asks for approval. ${found.fix}`,
  };
}

export type OsSandbox = { executor: Executor } | { problem: string; fix: string };

let cached: OsSandbox | undefined;

/** Find the sandbox for this platform. The result is cached for the process. */
export function findOsSandbox(): OsSandbox {
  cached ??= detect(process.platform);
  return cached;
}

function detect(platform: NodeJS.Platform): OsSandbox {
  const fix = 'Set "executor": "host" in .garuda/settings.json to hide this notice.';
  if (platform === "darwin") {
    return existsSync(SANDBOX_EXEC)
      ? { executor: new SeatbeltExecutor() }
      : { problem: `${SANDBOX_EXEC} is missing.`, fix };
  }
  if (platform === "linux") {
    const bwrap = onPath("bwrap");
    if (bwrap === undefined) {
      return {
        problem: "bubblewrap (bwrap) is not installed.",
        fix: 'Install it (for example: sudo apt install bubblewrap), or set "executor": "host" in .garuda/settings.json.',
      };
    }
    // bwrap can be present but blocked, for example when user namespaces are off.
    const probe = spawnSync(
      bwrap,
      ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-net", "--die-with-parent", "--", "true"],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (probe.status === 0) return { executor: new BwrapExecutor(bwrap) };
    const why = (probe.stderr || probe.error?.message || "unknown error").trim().split("\n")[0];
    return { problem: `bubblewrap cannot start a sandbox here (${why}).`, fix };
  }
  return { problem: `Garuda has no OS sandbox for ${platform}.`, fix };
}

function onPath(program: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(dir, program);
    if (dir !== "" && existsSync(path)) return path;
  }
  return undefined;
}
