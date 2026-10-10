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

/** Why Garuda stops (0.17): the strict profile needs the OS sandbox. */
export class StrictProfileError extends Error {}

/** The fix for a missing sandbox in the strict profile: never "use the host". */
function strictFix(platform: NodeJS.Platform): string {
  if (platform === "linux")
    return "Install bubblewrap (for example: sudo apt install bubblewrap) and allow user namespaces, or remove the strict profile.";
  return 'Run Garuda where the OS sandbox works, or remove the strict profile ("profile": "strict").';
}

/**
 * One config key picks the executor (N8). The loop receives the result as a dependency.
 * `strict` (0.17): the OS sandbox or a StrictProfileError; never the host.
 */
export function createExecutor(
  name: ExecutorName = "auto",
  find: () => OsSandbox = findOsSandbox,
  strict = false,
  platform: NodeJS.Platform = process.platform,
): ExecutorChoice {
  if (strict && name === "host") {
    throw new StrictProfileError(
      'The strict profile requires the OS sandbox, but "executor" is "host". Remove "executor": "host" from .garuda/settings.json, or remove the strict profile.',
    );
  }
  if (name === "host") return { executor: new HostExecutor() };
  const found = find();
  if ("executor" in found) return { executor: found.executor };
  if (strict) {
    throw new StrictProfileError(
      `The strict profile requires the OS sandbox, and this machine has none: ${found.problem} Garuda does not run commands on the host in this profile. ${strictFix(platform)}`,
    );
  }
  if (name === "os") throw new Error(`No OS sandbox: ${found.problem} ${found.fix}`);
  return {
    executor: new HostExecutor(),
    notice: `No OS sandbox: ${found.problem} Commands run on your machine, and each one asks for approval. ${found.fix}`,
  };
}

export type OsSandbox = { executor: Executor } | { problem: string; fix: string };

/** What the probe found: how to make an executor, or why there is none. */
type Detected = { make: () => Executor } | { problem: string; fix: string };

let cached: Detected | undefined;

/**
 * Find the sandbox for this platform. The probe result is cached for the process, but each call
 * gets a new executor (0.14.1): an executor's shutdown() kills its running commands, so one
 * Runtime (for example one of several eval tasks) must not stop the commands of another.
 */
export function findOsSandbox(): OsSandbox {
  cached ??= detect(process.platform);
  return "make" in cached ? { executor: cached.make() } : cached;
}

function detect(platform: NodeJS.Platform): Detected {
  const fix = 'Set "executor": "host" in .garuda/settings.json to hide this notice.';
  if (platform === "darwin") {
    if (!existsSync(SANDBOX_EXEC)) {
      return { problem: `${SANDBOX_EXEC} is missing.`, fix };
    }
    // sandbox-exec can be present but blocked, for example in a nested sandbox or container.
    const probe = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "--", "true"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (probe.status === 0) return { make: () => new SeatbeltExecutor() };
    const why = (probe.stderr || probe.error?.message || "unknown error").trim().split("\n")[0];
    return { problem: `sandbox-exec cannot start a sandbox here (${why}).`, fix };
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
    if (probe.status === 0) return { make: () => new BwrapExecutor(bwrap) };
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
