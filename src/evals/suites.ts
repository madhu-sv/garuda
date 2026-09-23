import { HARD_TASKS } from "./hardTasks.js";
import { EVAL_TASKS } from "./tasks.js";
import type { EvalTask } from "./types.js";

/**
 * Eval suites (N5).
 *   basic: 10 small repos (2–4 files). The 0.1 target: 7/10.
 *   hard:  6 tasks on shopkit (about 110 files). Search across files matters.
 */
export const EVAL_SUITES: Readonly<Record<string, readonly EvalTask[]>> = {
  basic: EVAL_TASKS,
  hard: HARD_TASKS,
};

export const ALL_TASKS: readonly EvalTask[] = Object.values(EVAL_SUITES).flat();
