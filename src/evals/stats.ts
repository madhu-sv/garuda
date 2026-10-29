import type { EvalResult } from "./types.js";

/**
 * Eval statistics (0.17, T11a; docs/lld/eval-evidence.md). Repeats of one task are not
 * independent, so the interval is a cluster bootstrap over tasks: one draw takes as many tasks as
 * the run has, with replacement, and all runs of each drawn task. A fixed seed gives the same
 * interval for the same results. Rates here are over all attempts: an error run is a failure.
 */

export const BOOTSTRAP_DRAWS = 10_000;
export const DEFAULT_SEED = 1;

/** A small seeded generator (mulberry32): the same seed gives the same numbers. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A new array in a random order from `seed` (Fisher-Yates). */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const random = seeded(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export interface TaskRuns {
  id: string;
  runs: number;
  /** Passes over all attempts. */
  passes: number;
  errors: number;
  results: EvalResult[];
}

/** The runs of each task, in the order of first appearance. */
export function byTask(results: readonly EvalResult[]): TaskRuns[] {
  const map = new Map<string, TaskRuns>();
  for (const r of results) {
    let t = map.get(r.id);
    if (t === undefined) {
      t = { id: r.id, runs: 0, passes: 0, errors: 0, results: [] };
      map.set(r.id, t);
    }
    t.runs++;
    if (r.passed) t.passes++;
    if (r.stopReason === "error") t.errors++;
    t.results.push(r);
  }
  return [...map.values()];
}

export interface Interval {
  rate: number;
  low: number;
  high: number;
  level: number;
  draws: number;
  seed: number;
  tasks: number;
}

/** The pass rate over all attempts, with a 95% cluster-bootstrap interval over tasks. */
export function passInterval(
  results: readonly EvalResult[],
  options: { seed?: number; draws?: number; level?: number } = {},
): Interval | undefined {
  const tasks = byTask(results);
  const runs = tasks.reduce((s, t) => s + t.runs, 0);
  if (tasks.length === 0 || runs === 0) return undefined;
  const seed = options.seed ?? DEFAULT_SEED;
  const draws = options.draws ?? BOOTSTRAP_DRAWS;
  const level = options.level ?? 0.95;
  const random = seeded(seed);
  const rates = new Float64Array(draws);
  for (let d = 0; d < draws; d++) {
    let passes = 0;
    let n = 0;
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[Math.floor(random() * tasks.length)] as TaskRuns;
      passes += t.passes;
      n += t.runs;
    }
    rates[d] = passes / n;
  }
  rates.sort();
  const tail = (1 - level) / 2;
  return {
    rate: tasks.reduce((s, t) => s + t.passes, 0) / runs,
    low: quantile(rates, tail),
    high: quantile(rates, 1 - tail),
    level,
    draws,
    seed,
    tasks: tasks.length,
  };
}

/**
 * The tasks with 2+ runs that passed every run, and those that passed none. A task whose runs all
 * failed with an error is not "passed none": the agent never ran. It is listed apart.
 */
export function consistency(results: readonly EvalResult[]): {
  repeated: number;
  allPassed: string[];
  nonePassed: string[];
  onlyErrors: string[];
} {
  const repeated = byTask(results).filter((t) => t.runs >= 2);
  return {
    repeated: repeated.length,
    allPassed: repeated.filter((t) => t.passes === t.runs).map((t) => t.id),
    nonePassed: repeated.filter((t) => t.passes === 0 && t.errors < t.runs).map((t) => t.id),
    onlyErrors: repeated.filter((t) => t.errors === t.runs).map((t) => t.id),
  };
}

export interface Spread {
  median: number;
  p95: number;
}

/** Median and p95 of steps, tokens and time over the scored runs (error runs left out). */
export function spread(
  results: readonly EvalResult[],
): { runs: number; steps: Spread; tokens: Spread; durationMs: Spread } | undefined {
  const scored = results.filter((r) => r.stopReason !== "error");
  if (scored.length === 0) return undefined;
  const of = (f: (r: EvalResult) => number): Spread => {
    const sorted = Float64Array.from(scored.map(f)).sort();
    return { median: quantile(sorted, 0.5), p95: quantile(sorted, 0.95) };
  };
  return {
    runs: scored.length,
    steps: of((r) => r.steps),
    tokens: of((r) => r.tokens),
    durationMs: of((r) => r.durationMs),
  };
}

/** The standard deviation of a task's steps over its scored runs; undefined below 2 runs. */
export function stepsSd(runs: readonly EvalResult[]): number | undefined {
  const steps = runs.filter((r) => r.stopReason !== "error").map((r) => r.steps);
  if (steps.length < 2) return undefined;
  const mean = steps.reduce((s, x) => s + x, 0) / steps.length;
  return Math.sqrt(steps.reduce((s, x) => s + (x - mean) ** 2, 0) / (steps.length - 1));
}

/**
 * The cost of all attempts (passes, failures and error runs) divided by the passes. "none" with
 * no pass; "unknown" when one run's cost is unknown; `minimum` when one run's cost is a minimum.
 */
export type CostPerPass =
  | { kind: "none"; totalUsd?: number }
  | { kind: "unknown" }
  | { kind: "value"; usd: number; minimum: boolean; totalUsd: number; passes: number };

export function costPerPass(results: readonly EvalResult[]): CostPerPass {
  if (results.some((r) => r.costUsd === undefined)) return { kind: "unknown" };
  const totalUsd = results.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const passes = results.filter((r) => r.passed).length;
  if (passes === 0) return { kind: "none", totalUsd };
  return {
    kind: "value",
    usd: totalUsd / passes,
    minimum: results.some((r) => r.costIncomplete === true),
    totalUsd,
    passes,
  };
}

/** Runs with at least one unexpected change, and the number of such files over all runs. */
export function unexpectedChanges(results: readonly EvalResult[]): {
  runs: number;
  files: number;
  measured: number;
} {
  const measured = results.filter((r) => r.unexpected !== undefined);
  return {
    runs: measured.filter((r) => (r.unexpected?.length ?? 0) > 0).length,
    files: measured.reduce((s, r) => s + (r.unexpected?.length ?? 0), 0),
    measured: measured.length,
  };
}

/** The value at `q` (0..1) of sorted numbers, by linear interpolation. */
export function quantile(sorted: ArrayLike<number>, q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}
