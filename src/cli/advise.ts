import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { garudaCommit } from "../buildCheck.js";
import { BUILD_COMMIT } from "../buildInfo.js";
import { type Comparison, compareReports, formatComparison, loadReport } from "../evals/compare.js";
import { taskHash } from "../evals/report.js";
import { repoEvalTasks } from "../evals/repoTasks.js";
import { costPerPass } from "../evals/stats.js";
import type { EvalResult } from "../evals/types.js";
import { costOf, type Price, responseCost } from "../model/pricing.js";
import { loadModelsConfig, resolveModel } from "../model/providers.js";
import type { ModelResponse, Usage } from "../model/types.js";
import { newSessionId } from "../session/store.js";
import { VERSION } from "../version.js";
import { escapeHtml } from "./exportHtml.js";

/**
 * `garuda advise` (UX U8; docs/lld/ux.md): which model to use for this repository, from its own
 * history. It runs the repo suite (`garuda eval --from-git`) on two models, compares them with
 * `eval compare`, and gives advice by the eval rules: a difference whose interval contains 0 is
 * no difference, and on a tie the cheaper model wins. It adds no new measure.
 */

/** Decision D7: Haiku and Sonnet of the current family, 2 runs a task, at most $2. */
export const ADVISE_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const;
export const ADVISE_REPEAT = 2;
export const ADVISE_MAX_COST = 2;
/** A guess for the cost estimate: tokens of one run of a repo task. */
export const GUESS_INPUT_TOKENS = 60_000;
export const GUESS_OUTPUT_TOKENS = 1_500;

/** The estimated cost of `runs` runs at a model's price (a guess: see the token counts above). */
export function estimateUsd(price: Price | undefined, runs: number): number | undefined {
  if (price === undefined) return undefined;
  return (
    (runs * (GUESS_INPUT_TOKENS * price.input + GUESS_OUTPUT_TOKENS * price.output)) / 1_000_000
  );
}

/** The advice from a comparison of model A and model B. */
export function adviceText(a: string, b: string, c: Comparison, tasks: number): string {
  const rough =
    tasks < 10 ? ` With ${tasks} task${tasks === 1 ? "" : "s"}, this is a rough guide.` : "";
  if (c.verdict === "B passes more")
    return `Advice: ${b} for this repo. It passes more often.${rough}`;
  if (c.verdict === "B passes less")
    return `Advice: ${a} for this repo. It passes more often.${rough}`;
  // 0.18.2: in the first run on 0.18.1, both models passed none because the check itself could not
  // run in the sandbox. That says nothing about the models.
  if (c.rateA === 0 && c.rateB === 0) {
    return `Advice: none. Neither model passed a task, so the check itself may fail: read a run's "reason" in report.json before you trust this.`;
  }
  const ratio = c.costRatio;
  if (ratio === undefined) {
    return `Advice: no clear difference in passes, and the cost could not be compared.${rough}`;
  }
  const times = (x: number) => `${x.toFixed(1)} times`;
  if (ratio.verdict === "B costs less per accepted change") {
    return `Advice: ${b} for this repo. It passes as often, and ${a} costs ${times(1 / ratio.value)} as much per accepted change.${rough}`;
  }
  if (ratio.verdict === "B costs more per accepted change") {
    return `Advice: ${a} for this repo. It passes as often, and ${b} costs ${times(ratio.value)} as much per accepted change.${rough}`;
  }
  const cheaper = ratio.value <= 1 ? b : a;
  return `Advice: either. No clear difference in passes or in cost; ${cheaper} was cheaper in these runs.${rough}`;
}

/** The advice page: the comparison and the advice, escaped, with no script or link. */
export function adviceHtml(comparison: string, advice: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    "<title>Garuda advise</title>",
    "<style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 16px}",
    "pre{font:13px/1.45 ui-monospace,monospace;white-space:pre-wrap}.advice{font-weight:600}</style>",
    "</head><body><h1>Which model for this repository</h1>",
    `<p class="advice">${escapeHtml(advice)}</p>`,
    `<pre>${escapeHtml(comparison)}</pre>`,
    "</body></html>",
    "",
  ].join("\n");
}

export interface AdviseOptions {
  /** --models a,b: two model ids. */
  models?: string[];
  repeat?: number;
  maxCost?: number;
  seed?: number;
  /** --yes: start without the question. */
  yes?: boolean;
  /** --parallel <n>: runs at the same time (0.18.2, default 4). */
  parallel?: number;
}

/** Runs at the same time (0.18.2): one at a time took 64 minutes for 30 repo tasks. */
export const ADVISE_PARALLEL = 4;

/** An earlier eval run, from its report.json. */
export interface PastRun {
  path: string;
  model: string | undefined;
  version: string | undefined;
  /** The build's git commit, as the report records it. */
  commit: string | undefined;
  suite: string | undefined;
  repeat: number | undefined;
  seed: number | undefined;
  tasks: Record<string, string> | undefined;
  results: EvalResult[];
  mtimeMs: number;
}

/** The eval runs in `.garuda/evals`: run folders, and the a and b folders of advise runs. */
export function pastRuns(evalsDir: string): PastRun[] {
  const folders: string[] = [];
  try {
    for (const name of readdirSync(evalsDir)) {
      const path = join(evalsDir, name);
      folders.push(path, join(path, "a"), join(path, "b"));
    }
  } catch {
    return [];
  }
  const out: PastRun[] = [];
  for (const folder of folders) {
    const file = join(folder, "report.json");
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const garuda = data.garuda as { version?: unknown; commit?: unknown } | undefined;
      out.push({
        path: folder,
        model:
          typeof data.spec === "string"
            ? data.spec
            : typeof data.model === "string"
              ? data.model
              : undefined,
        version: typeof garuda?.version === "string" ? garuda.version : undefined,
        commit: typeof garuda?.commit === "string" ? garuda.commit : undefined,
        suite: typeof data.suite === "string" ? data.suite : undefined,
        repeat: typeof data.repeat === "number" ? data.repeat : undefined,
        seed: typeof data.seed === "number" ? data.seed : undefined,
        tasks:
          typeof data.tasks === "object" && data.tasks !== null
            ? (data.tasks as Record<string, string>)
            : undefined,
        results: Array.isArray(data.results) ? (data.results as EvalResult[]) : [],
        mtimeMs: statSync(file).mtimeMs,
      });
    } catch {
      // No report here, or a broken one.
    }
  }
  return out.sort((x, y) => y.mtimeMs - x.mtimeMs);
}

const sameTasks = (a: Record<string, string> | undefined, b: Record<string, string>) =>
  a !== undefined &&
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(b).every(([id, hash]) => a[id] === hash);

/**
 * An earlier run that advise can use instead of a new one (0.18.2): the same model, the same repo
 * tasks (by hash), repeat and seed, every run there, and this version and build commit of Garuda.
 * A run of another build is another agent: runs before 0.18.1 could read the answer from the
 * user's checkout, and runs of a 0.18.1 dev build before the ~/Library fix failed every check.
 */
export function reusableRun(
  runs: readonly PastRun[],
  want: {
    model: string;
    repeat: number;
    seed: number;
    tasks: Record<string, string>;
    version: string;
    commit: string | undefined;
  },
): PastRun | undefined {
  const count = Object.keys(want.tasks).length * want.repeat;
  return runs.find(
    (r) =>
      r.model === want.model &&
      r.version === want.version &&
      r.commit === want.commit &&
      r.suite === "repo" &&
      r.repeat === want.repeat &&
      r.seed === want.seed &&
      sameTasks(r.tasks, want.tasks) &&
      r.results.length === count,
  );
}

/** The mean cost of one run of these tasks with this model, from earlier runs; undefined: none. */
export function pastCostPerRun(
  runs: readonly PastRun[],
  model: string,
  tasks: Record<string, string>,
): number | undefined {
  const results = runs
    .filter((r) => r.model === model && sameTasks(r.tasks, tasks))
    .flatMap((r) => r.results);
  if (results.length === 0 || results.some((r) => r.costUsd === undefined)) return undefined;
  return results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) / results.length;
}

/**
 * What one session file would cost at another price: each model request priced on its own, so a
 * price with a long-prompt level (Haiku 5.5 over 100 000 tokens) applies where it applied. Undefined
 * when the file is missing, or has usage that cannot be priced again: a subagent (its own model),
 * unreported tokens or a child's debit.
 */
export function repricedSessionCost(file: string, price: Price): number | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let usd = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    if (record.type === "unreported" || record.type === "child_debit") return undefined;
    if (line.includes('"subagent":{')) return undefined;
    if (record.type === "assistant") {
      const cost = responseCost(record.response as ModelResponse, price);
      if (cost === undefined) return undefined;
      usd += cost;
    }
    if (record.type === "side_usage") usd += costOf(record.usage as Usage, price);
  }
  return usd;
}

/**
 * The mean cost of one run at `price`, from the session files of earlier runs of `model` on these
 * tasks; undefined when fewer than half of them can be priced. A file is looked for next to its
 * report first, so a moved folder still works.
 */
export function repricedCostPerRun(
  runs: readonly PastRun[],
  model: string,
  tasks: Record<string, string>,
  price: Price | undefined,
): number | undefined {
  if (price === undefined) return undefined;
  const costs: (number | undefined)[] = [];
  for (const run of runs.filter((r) => r.model === model && sameTasks(r.tasks, tasks))) {
    for (const result of run.results) {
      const file = result.sessionFile;
      if (file === undefined) {
        costs.push(undefined);
        continue;
      }
      const near = join(run.path, basename(file));
      costs.push(repricedSessionCost(near, price) ?? repricedSessionCost(file, price));
    }
  }
  // A run with a subagent or unreported tokens cannot be priced again: the mean of the rest, when
  // they are at least half (2 of 30 in the first real advise run).
  const known = costs.filter((c): c is number => c !== undefined);
  if (known.length === 0 || known.length * 2 < costs.length) return undefined;
  return known.reduce((sum, c) => sum + c, 0) / known.length;
}

/**
 * The cost of `runs` new runs of a model: from its own earlier runs; else from the other model's
 * requests at this model's prices; else a guess. (A ratio of list prices was wrong by 5 times for
 * Haiku 5.5, whose long prompts cost 5 times its base price.)
 */
export function costEstimate(
  runs: number,
  own: number | undefined,
  repriced: { perRun: number | undefined; from: string },
  price: Price | undefined,
): { usd: number | undefined; how: string } {
  if (own !== undefined) return { usd: own * runs, how: "from earlier runs" };
  if (repriced.perRun !== undefined) {
    return {
      usd: repriced.perRun * runs,
      how: `from ${repriced.from}'s requests at this model's prices`,
    };
  }
  return { usd: estimateUsd(price, runs), how: "a guess" };
}

/** The sum, or undefined when one value is unknown. */
export const sumKnown = (values: readonly (number | undefined)[]): number | undefined =>
  values.some((v) => v === undefined)
    ? undefined
    : values.reduce((sum: number, v) => sum + (v ?? 0), 0);

/** The command that goes on after a stop at the cap; the finished model's run is reused. */
export function continueCommand(
  a: string,
  b: string,
  repeat: number,
  seed: number,
  maxCost: number,
): string {
  return `garuda advise --models ${a},${b} --repeat ${repeat} --seed ${seed} --max-cost ${Math.ceil(maxCost)}`;
}

export async function runAdvise(options: AdviseOptions): Promise<number> {
  const [a, b] = options.models ?? ADVISE_MODELS;
  if (
    a === undefined ||
    b === undefined ||
    options.models?.length === 1 ||
    (options.models?.length ?? 2) > 2
  ) {
    process.stderr.write("Give two models: --models <a>,<b>.\n");
    return 1;
  }
  const repeat = options.repeat ?? ADVISE_REPEAT;
  const maxCost = options.maxCost ?? ADVISE_MAX_COST;
  const seed = options.seed ?? 1;
  const parallel = options.parallel ?? ADVISE_PARALLEL;
  if (
    !Number.isInteger(repeat) ||
    repeat < 1 ||
    !(maxCost > 0) ||
    !Number.isInteger(parallel) ||
    parallel < 1
  ) {
    process.stderr.write(
      "--repeat and --parallel must be whole numbers of 1 or more, and --max-cost above 0.\n",
    );
    return 1;
  }
  const { repoSuite, runEvalCommand } = await import("./evalCommand.js");
  const suite = await repoSuite();
  if (typeof suite === "string") {
    process.stderr.write(`${suite}\n`);
    return 1;
  }
  const repoTasks = repoEvalTasks(suite);
  const tasks = repoTasks.length;
  const hashes = Object.fromEntries(repoTasks.map((t) => [t.id, taskHash(t)]));
  const models = await loadModelsConfig();
  if (models.problem !== undefined) {
    process.stderr.write(`${models.problem}\n`);
    return 1;
  }
  let prices: [Price | undefined, Price | undefined];
  try {
    prices = [resolveModel(a, models.config).info.price, resolveModel(b, models.config).info.price];
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  const evalsDir = join(process.cwd(), ".garuda", "evals");
  const past = pastRuns(evalsDir);
  // The commit as reports record it: the build's, else the checkout's (buildFields).
  const commit = BUILD_COMMIT ?? (await garudaCommit());
  const want = { repeat, seed, tasks: hashes, version: VERSION, commit };
  const reuse = [
    reusableRun(past, { ...want, model: a }),
    reusableRun(past, { ...want, model: b }),
  ];
  const runs = tasks * repeat;
  const perRun = [pastCostPerRun(past, a, hashes), pastCostPerRun(past, b, hashes)];
  // Repricing reads session files: only when a model has no history of its own.
  const repriced = (i: 0 | 1, from: string) =>
    perRun[i] === undefined ? repricedCostPerRun(past, from, hashes, prices[i]) : undefined;
  const estimates = [
    costEstimate(runs, perRun[0], { perRun: repriced(0, b), from: b }, prices[0]),
    costEstimate(runs, perRun[1], { perRun: repriced(1, a), from: a }, prices[1]),
  ];
  const line = (model: string, i: 0 | 1) => {
    const r = reuse[i];
    const e = estimates[i];
    return r !== undefined
      ? `  ${model}: reuses ${r.path} (Garuda ${r.version}, ${r.results.length} runs)`
      : `  ${model}: ${runs} runs, ${e?.usd === undefined ? "cost unknown" : `about $${e.usd.toFixed(2)} (${e.how})`}`;
  };
  // What the new runs cost: undefined when a model's cost is unknown.
  const toSpend = sumKnown(
    [0, 1].filter((i) => reuse[i] === undefined).map((i) => estimates[i]?.usd),
  );
  process.stderr.write(
    [
      `Your repo: ${tasks} task${tasks === 1 ? "" : "s"} from its history (tests that fail before the commit and pass after it).`,
      `${repeat} run${repeat === 1 ? "" : "s"} a task, ${parallel} at a time, seed ${seed}:`,
      line(a, 0),
      line(b, 1),
      `Cap: --max-cost $${maxCost}; it stops before a model that would pass it.`,
      "",
    ].join("\n"),
  );
  if (toSpend !== undefined && toSpend > maxCost) {
    process.stderr.write(
      `The estimate passes the cap. To go on: ${continueCommand(a, b, repeat, seed, toSpend * 1.25)}\n`,
    );
    return 1;
  }
  if (options.yes !== true && (reuse[0] === undefined || reuse[1] === undefined)) {
    if (!process.stdin.isTTY) {
      process.stderr.write("Add --yes to start without a question.\n");
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question("Start? (y/N) ");
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) return 1;
  }
  const dir = join(evalsDir, `advise-${newSessionId()}`);
  mkdirSync(dir, { recursive: true });
  // The report folder, or undefined when the run stopped on an error (eval returns 1; 2 is fails).
  const runModel = async (
    model: string,
    label: "a" | "b",
    i: 0 | 1,
  ): Promise<string | undefined> => {
    const earlier = reuse[i];
    if (earlier !== undefined) {
      process.stderr.write(`Reusing ${earlier.path} for ${model}.\n`);
      return earlier.path;
    }
    const outDir = join(dir, label);
    const code = await runEvalCommand({
      model,
      suite: "repo",
      repeat,
      shuffle: true,
      seed,
      parallel,
      outDir,
      progress: model.replace(/^claude-/, ""),
    });
    return code === 1 ? undefined : outDir;
  };
  const pathA = await runModel(a, "a", 0);
  if (pathA === undefined) return 1;
  const first = await loadReport(pathA);
  if (reuse[0] === undefined && reuse[1] === undefined) {
    // The second model's cost: its own history, else the first model's new requests at its prices.
    const spent = costPerPass(first.results);
    const spentA = spent.kind === "unknown" ? undefined : spent.totalUsd;
    const nextB = costEstimate(
      runs,
      perRun[1],
      { perRun: repricedCostPerRun(pastRuns(evalsDir), a, hashes, prices[1]), from: a },
      prices[1],
    ).usd;
    if (spentA !== undefined && nextB !== undefined && spentA + nextB > maxCost) {
      process.stderr.write(
        [
          `Stopped before ${b}: ${a} cost $${spentA.toFixed(2)}, and ${b} would cost about $${nextB.toFixed(2)}, past $${maxCost}.`,
          `${a}'s run is kept and will be reused. To go on: ${continueCommand(a, b, repeat, seed, nextB * 1.25)}`,
          "",
        ].join("\n"),
      );
      return 1;
    }
  }
  const pathB = await runModel(b, "b", 1);
  if (pathB === undefined) return 1;
  const second = await loadReport(pathB);
  const result = compareReports(first, second, { seed });
  if ("problems" in result) {
    process.stderr.write(`The two runs cannot be compared:\n${result.problems.join("\n")}\n`);
    return 1;
  }
  const comparison = formatComparison(first, second, result.comparison);
  const advice = adviceText(a, b, result.comparison, tasks);
  writeFileSync(join(dir, "advice.txt"), `${advice}\n\n${comparison}\n`);
  writeFileSync(join(dir, "report.html"), adviceHtml(comparison, advice));
  process.stdout.write(`\n${comparison}\n\n${advice}\nReport: ${join(dir, "report.html")}\n`);
  return 0;
}
