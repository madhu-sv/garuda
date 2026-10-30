import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  BOOTSTRAP_DRAWS,
  byTask,
  costPerPass,
  DEFAULT_SEED,
  quantile,
  seeded,
  spread,
  unexpectedChanges,
} from "./stats.js";
import type { EvalResult } from "./types.js";

/**
 * `garuda eval compare` (0.17, T11a; docs/lld/eval-evidence.md): two runs of the same tasks, an A/B
 * of a setting or Garuda against a baseline. The difference of the pass rates (B − A, over all
 * attempts) gets a paired 95% interval: one bootstrap draw takes tasks with replacement and, for
 * each drawn task, the runs of both arms. An interval that contains 0 is "no clear difference",
 * never a win. Reports whose tasks differ are refused.
 */

export interface LoadedReport {
  path: string;
  /** 1: before 0.17 (no task hashes), 2: with metadata. */
  schema: number;
  model: string | undefined;
  seed: number | undefined;
  /** Task id → hash (version 2 only). */
  tasks: Record<string, string> | undefined;
  results: EvalResult[];
}

/** Read a report: a report.json file, or the run folder that holds one. */
export async function loadReport(path: string): Promise<LoadedReport> {
  const file = (await stat(path)).isDirectory() ? join(path, "report.json") : path;
  const data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  return parseReport(data, file);
}

export function parseReport(data: Record<string, unknown>, path: string): LoadedReport {
  if (!Array.isArray(data.results)) throw new Error(`${path} is not an eval report (no results).`);
  const schema = typeof data.schema === "number" ? data.schema : 1;
  const tasks =
    schema >= 2 && data.tasks !== null && typeof data.tasks === "object"
      ? (data.tasks as Record<string, string>)
      : undefined;
  return {
    path,
    schema,
    model:
      typeof data.spec === "string"
        ? data.spec
        : typeof data.model === "string"
          ? data.model
          : undefined,
    seed: typeof data.seed === "number" ? data.seed : undefined,
    tasks,
    results: data.results as EvalResult[],
  };
}

export interface ArmRuns {
  passes: number;
  runs: number;
  /** The cost of all runs; undefined when one run's cost is unknown. */
  costUsd: number | undefined;
  /** One run's cost is a minimum. */
  minimum: boolean;
}

export interface TaskRow {
  id: string;
  a: ArmRuns;
  b: ArmRuns;
}

/**
 * The cost per accepted change of B over A (0.17): cost of all attempts / passes, each arm over
 * the drawn tasks, with the same paired bootstrap as the pass rate. A draw in which an arm has no
 * pass gives no ratio and is skipped.
 */
export interface CostRatio {
  value: number;
  low: number;
  high: number;
  draws: number;
  skipped: number;
  verdict:
    | "no clear difference"
    | "B costs more per accepted change"
    | "B costs less per accepted change";
}

export interface Comparison {
  rows: TaskRow[];
  rateA: number;
  rateB: number;
  /** rateB − rateA, with its paired interval. */
  difference: {
    value: number;
    low: number;
    high: number;
    level: number;
    draws: number;
    seed: number;
  };
  verdict: "no clear difference" | "B passes more" | "B passes less";
  /** Undefined when a run's cost is unknown or an arm has no pass. */
  costRatio?: CostRatio;
  notes: string[];
}

/** The comparison, or the reasons why the two reports cannot be compared. */
export function compareReports(
  a: LoadedReport,
  b: LoadedReport,
  options: { seed?: number; draws?: number; level?: number } = {},
): { comparison: Comparison } | { problems: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  const idsA = [...new Set(a.results.map((r) => r.id))].sort();
  const idsB = [...new Set(b.results.map((r) => r.id))].sort();
  if (idsA.join("\n") !== idsB.join("\n")) {
    const onlyA = idsA.filter((id) => !idsB.includes(id));
    const onlyB = idsB.filter((id) => !idsA.includes(id));
    problems.push(
      `The reports ran different tasks${onlyA.length > 0 ? `; only in A: ${onlyA.join(", ")}` : ""}${onlyB.length > 0 ? `; only in B: ${onlyB.join(", ")}` : ""}.`,
    );
  }
  if (a.tasks !== undefined && b.tasks !== undefined) {
    const changed = idsA.filter((id) => idsB.includes(id) && a.tasks?.[id] !== b.tasks?.[id]);
    if (changed.length > 0) {
      problems.push(
        `These tasks changed between the runs (their hashes differ): ${changed.join(", ")}. Run both arms on the same tasks.`,
      );
    }
  } else {
    const old = [a, b].filter((r) => r.tasks === undefined).map((r) => r.path);
    notes.push(
      `${old.join(" and ")} ${old.length === 1 ? "has" : "have"} no task hashes (a report before 0.17): Garuda cannot check that the tasks were the same.`,
    );
  }
  if (problems.length > 0) return { problems };
  if (idsA.length === 0) return { problems: ["The reports have no runs."] };

  const tasksA = new Map(byTask(a.results).map((t) => [t.id, t]));
  const tasksB = new Map(byTask(b.results).map((t) => [t.id, t]));
  const rows: TaskRow[] = idsA.map((id) => {
    const ta = tasksA.get(id);
    const tb = tasksB.get(id);
    const arm = (t: typeof ta): ArmRuns => {
      const results = t?.results ?? [];
      return {
        passes: t?.passes ?? 0,
        runs: t?.runs ?? 0,
        costUsd: results.some((r) => r.costUsd === undefined)
          ? undefined
          : results.reduce((s, r) => s + (r.costUsd ?? 0), 0),
        minimum: results.some((r) => r.costIncomplete === true),
      };
    };
    return { id, a: arm(ta), b: arm(tb) };
  });
  const rate = (side: "a" | "b", list: readonly TaskRow[]) =>
    list.reduce((s, r) => s + r[side].passes, 0) / list.reduce((s, r) => s + r[side].runs, 0);
  const rateA = rate("a", rows);
  const rateB = rate("b", rows);

  const seed = options.seed ?? DEFAULT_SEED;
  const draws = options.draws ?? BOOTSTRAP_DRAWS;
  const level = options.level ?? 0.95;
  const random = seeded(seed);
  const diffs = new Float64Array(draws);
  for (let d = 0; d < draws; d++) {
    let pa = 0;
    let na = 0;
    let pb = 0;
    let nb = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[Math.floor(random() * rows.length)] as TaskRow;
      pa += r.a.passes;
      na += r.a.runs;
      pb += r.b.passes;
      nb += r.b.runs;
    }
    diffs[d] = pb / nb - pa / na;
  }
  diffs.sort();
  const tail = (1 - level) / 2;
  const low = quantile(diffs, tail);
  const high = quantile(diffs, 1 - tail);
  const verdict = low > 0 ? "B passes more" : high < 0 ? "B passes less" : "no clear difference";
  if (low === high) {
    notes.push(
      "Every draw gave the same difference, so the interval shows no uncertainty: more tasks, or tasks that sometimes fail, are needed to measure it.",
    );
  }
  if (rows.length < 10) notes.push(roughNote(rows.length));
  if (a.seed !== undefined && b.seed !== undefined && a.seed !== b.seed) {
    notes.push(
      `The arms ran with different seeds (${a.seed} and ${b.seed}): their run orders differ.`,
    );
  }
  const cost = costRatio(rows, seed, draws, level);
  if (typeof cost === "string") notes.push(cost);
  else if (cost.skipped > draws * 0.05) {
    notes.push(
      `The cost interval skipped ${cost.skipped} of ${draws} draws (an arm had no pass in them).`,
    );
  }
  if (rows.some((r) => r.a.minimum || r.b.minimum)) {
    notes.push("A run's cost is a minimum (no reported usage): the cost ratio is approximate.");
  }
  const runsA = rows.map((r) => r.a.runs);
  const runsB = rows.map((r) => r.b.runs);
  if (Math.min(...runsA, ...runsB) < 3) {
    notes.push(
      "Some tasks have fewer than 3 runs in an arm: repeat each task 3 times or more (--repeat 3).",
    );
  }
  return {
    comparison: {
      rows,
      rateA,
      rateB,
      difference: { value: rateB - rateA, low, high, level, draws, seed },
      verdict,
      ...(typeof cost === "string" ? {} : { costRatio: cost }),
      notes,
    },
  };
}

/** The cost ratio with its paired interval, or why there is none. */
function costRatio(
  rows: readonly TaskRow[],
  seed: number,
  draws: number,
  level: number,
): CostRatio | string {
  if (rows.some((r) => r.a.costUsd === undefined || r.b.costUsd === undefined)) {
    return "A run's cost is unknown: no cost comparison.";
  }
  const per = (list: readonly TaskRow[], side: "a" | "b") => {
    const passes = list.reduce((s, r) => s + r[side].passes, 0);
    const cost = list.reduce((s, r) => s + (r[side].costUsd ?? 0), 0);
    return passes === 0 ? undefined : cost / passes;
  };
  const a = per(rows, "a");
  const b = per(rows, "b");
  if (a === undefined || b === undefined || a === 0) {
    return "An arm has no pass (or no cost): no cost ratio.";
  }
  const random = seeded(seed);
  const ratios: number[] = [];
  const drawn: TaskRow[] = new Array(rows.length);
  for (let d = 0; d < draws; d++) {
    for (let i = 0; i < rows.length; i++) {
      drawn[i] = rows[Math.floor(random() * rows.length)] as TaskRow;
    }
    const ca = per(drawn, "a");
    const cb = per(drawn, "b");
    if (ca !== undefined && cb !== undefined && ca > 0) ratios.push(cb / ca);
  }
  const sorted = Float64Array.from(ratios).sort();
  const tail = (1 - level) / 2;
  const low = quantile(sorted, tail);
  const high = quantile(sorted, 1 - tail);
  return {
    value: b / a,
    low,
    high,
    draws,
    skipped: draws - ratios.length,
    verdict:
      low > 1
        ? "B costs more per accepted change"
        : high < 1
          ? "B costs less per accepted change"
          : "no clear difference",
  };
}

/** The caution for an interval from few tasks (also in the run report). */
export function roughNote(tasks: number): string {
  return `Only ${tasks} task${tasks === 1 ? "" : "s"}: with fewer than 10 tasks the interval is a rough guide.`;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number) => {
  const points = Math.round(Math.abs(x) * 100);
  // The user's live run printed "±0 pts to ±0 pts": a zero has no sign.
  return points === 0 ? "0 pts" : `${x > 0 ? "+" : "−"}${points} pts`;
};

/** The comparison as text for the terminal. */
export function formatComparison(a: LoadedReport, b: LoadedReport, c: Comparison): string {
  const width = Math.max(4, ...c.rows.map((r) => r.id.length));
  const lines = [
    `A: ${a.path}${a.model === undefined ? "" : ` (${a.model})`}`,
    `B: ${b.path}${b.model === undefined ? "" : ` (${b.model})`}`,
    "",
    `${"Task".padEnd(width)}  A        B`,
    ...c.rows.map(
      (r) =>
        `${r.id.padEnd(width)}  ${`${r.a.passes}/${r.a.runs}`.padEnd(7)}  ${r.b.passes}/${r.b.runs}`,
    ),
    "",
    `Pass rate over all attempts: A ${pct(c.rateA)}, B ${pct(c.rateB)}; B − A ${signed(c.difference.value)} (95% paired interval ${signed(c.difference.low)} to ${signed(c.difference.high)}; ${c.difference.draws} draws, seed ${c.difference.seed})`,
    `Verdict: ${c.verdict}${c.verdict === "no clear difference" ? " (the interval contains 0)" : ""}.`,
  ];
  for (const [name, report] of [
    ["A", a],
    ["B", b],
  ] as const) {
    const cost = costPerPass(report.results);
    const u = unexpectedChanges(report.results);
    const s = spread(report.results);
    lines.push(
      `${name}: cost per accepted change ${
        cost.kind === "unknown"
          ? "unknown"
          : cost.kind === "none"
            ? "no passes"
            : `${cost.minimum ? "≥ " : ""}$${cost.usd.toFixed(4)}`
      } · unexpected changes ${u.measured === 0 ? "not measured" : `${u.runs} of ${u.measured} runs`} · median time ${s === undefined ? "–" : `${Math.round(s.durationMs.median / 1000)} s`}`,
    );
  }
  if (c.costRatio !== undefined) {
    const x = (v: number) => `×${v.toFixed(2)}`;
    lines.push(
      `Cost per accepted change: B/A ${x(c.costRatio.value)} (95% paired interval ${x(c.costRatio.low)} to ${x(c.costRatio.high)}). Verdict: ${c.costRatio.verdict}${c.costRatio.verdict === "no clear difference" ? " (the interval contains ×1.00)" : ""}.`,
    );
  }
  for (const note of c.notes) lines.push(`Note: ${note}`);
  return lines.join("\n");
}
