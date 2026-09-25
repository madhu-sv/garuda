import { HARD_TASKS } from "./hardTasks.js";
import { JAVA_TASKS } from "./javaTasks.js";
import { PYTHON_TASKS } from "./pythonTasks.js";
import { EVAL_TASKS } from "./tasks.js";
import type { ToolchainId } from "./toolchains.js";
import type { EvalTask } from "./types.js";

/**
 * Eval suites (N5).
 *   basic:  10 small Node repos (2–4 files). The 0.1 target: 7/10.
 *   hard:   6 tasks on shopkit (about 110 files). Search across files matters.
 *   java:   5 Maven projects with JUnit 5 (0.3). Needs `garuda eval --prepare java` once.
 *   python: 5 pytest projects (0.3). Needs python3 with pytest.
 */
export const EVAL_SUITES: Readonly<Record<string, readonly EvalTask[]>> = {
  basic: EVAL_TASKS,
  hard: HARD_TASKS,
  java: JAVA_TASKS,
  python: PYTHON_TASKS,
};

export const ALL_TASKS: readonly EvalTask[] = Object.values(EVAL_SUITES).flat();

/** The toolchains that some tasks need. */
export function requiredToolchains(tasks: readonly EvalTask[]): ToolchainId[] {
  return [...new Set(tasks.flatMap((t) => t.requires ?? []))];
}
