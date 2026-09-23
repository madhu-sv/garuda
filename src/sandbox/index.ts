import { HostExecutor } from "./host.js";
import type { Executor } from "./types.js";

export type { ExecPolicy, ExecResult, Executor, Isolation } from "./types.js";

/** Executor names that the config key `executor` accepts. 0.2 adds "os". */
export const EXECUTOR_NAMES = ["host"] as const;
export type ExecutorName = (typeof EXECUTOR_NAMES)[number];

/** One config key picks the executor (N8). The loop receives the result as a dependency. */
export function createExecutor(name: ExecutorName = "host"): Executor {
  switch (name) {
    case "host":
      return new HostExecutor();
  }
}
