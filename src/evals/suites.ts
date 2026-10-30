import { HARD_TASKS } from "./hardTasks.js";
import { HELD_OUT_TASKS } from "./heldOutTasks.js";
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
 * These are the dev split. The held-out split (0.17, T11c) is HELD_OUT_TASKS, outside every suite:
 * only `--split heldout` or `--split all` runs it.
 */
export const EVAL_SUITES: Readonly<Record<string, readonly EvalTask[]>> = {
  basic: EVAL_TASKS,
  hard: HARD_TASKS,
  java: JAVA_TASKS,
  python: PYTHON_TASKS,
};

/** Every dev task of the built-in suites. */
export const ALL_TASKS: readonly EvalTask[] = Object.values(EVAL_SUITES).flat();

export { HELD_OUT_TASKS };

export const EVAL_SPLITS = ["dev", "heldout", "all"] as const;
export type EvalSplit = (typeof EVAL_SPLITS)[number];

export interface TaskChoice {
  /** -s; undefined when the user gave none. */
  suite?: string | undefined;
  /** --split; default dev. */
  split?: string | undefined;
  /** -t ids. */
  task?: readonly string[] | undefined;
  /** The repo suite, when one is built. */
  repoTasks?: readonly EvalTask[] | undefined;
}

/**
 * The tasks of one run (0.17, T11c). The default split is dev, so a plain `garuda eval` never runs
 * a held-out task: `-s` picks among the dev suites, `--split heldout` takes the held-out set (and
 * `-t` picks within it), `--split all` takes both (`-s` defaults to all there).
 */
export function chooseTasks(
  choice: TaskChoice,
): { tasks: readonly EvalTask[] } | { problem: string } {
  const split = choice.split ?? "dev";
  if (!(EVAL_SPLITS as readonly string[]).includes(split)) {
    return { problem: `Unknown split ${split}. Use: ${EVAL_SPLITS.join(", ")}.` };
  }
  const pick = (pool: readonly EvalTask[]) =>
    choice.task === undefined ? pool : pool.filter((t) => choice.task?.includes(t.id));
  if (split === "heldout") {
    if (choice.suite !== undefined) {
      return {
        problem:
          "-s picks dev suites. With --split heldout, leave it out; -t picks held-out tasks.",
      };
    }
    return { tasks: pick(HELD_OUT_TASKS) };
  }
  const suite = choice.suite ?? (split === "all" ? "all" : "basic");
  const suiteTasks =
    suite === "all" ? ALL_TASKS : suite === "repo" ? choice.repoTasks : EVAL_SUITES[suite];
  if (suiteTasks === undefined) {
    return {
      problem: `Unknown suite ${suite}. Use: ${[...Object.keys(EVAL_SUITES), "all", "repo"].join(", ")}.`,
    };
  }
  // -t picks from every built-in dev suite; with -s repo, from the repo suite.
  const devPool = suite === "repo" ? suiteTasks : ALL_TASKS;
  const dev = choice.task === undefined ? suiteTasks : pick(devPool);
  if (split === "all") return { tasks: [...dev, ...pick(HELD_OUT_TASKS)] };
  const heldOut = (choice.task ?? []).filter((id) => HELD_OUT_TASKS.some((t) => t.id === id));
  if (heldOut.length > 0) {
    return { problem: `${heldOut.join(", ")}: held-out task(s). Add --split heldout to run them.` };
  }
  return { tasks: dev };
}

/** The toolchains that some tasks need. */
export function requiredToolchains(tasks: readonly EvalTask[]): ToolchainId[] {
  return [...new Set(tasks.flatMap((t) => t.requires ?? []))];
}
