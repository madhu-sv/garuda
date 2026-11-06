import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type Comparison, compareReports, formatComparison, loadReport } from "../evals/compare.js";
import { repoEvalTasks } from "../evals/repoTasks.js";
import { costPerPass } from "../evals/stats.js";
import type { Price } from "../model/pricing.js";
import { loadModelsConfig, resolveModel } from "../model/providers.js";
import { newSessionId } from "../session/store.js";
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
  if (!Number.isInteger(repeat) || repeat < 1 || !(maxCost > 0)) {
    process.stderr.write("--repeat must be a whole number of 1 or more, and --max-cost above 0.\n");
    return 1;
  }
  const { repoSuite, runEvalCommand } = await import("./evalCommand.js");
  const suite = await repoSuite();
  if (typeof suite === "string") {
    process.stderr.write(`${suite}\n`);
    return 1;
  }
  const tasks = repoEvalTasks(suite).length;
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
  const runs = tasks * repeat;
  const estimates = prices.map((p) => estimateUsd(p, runs));
  const total =
    estimates[0] === undefined || estimates[1] === undefined
      ? undefined
      : estimates[0] + estimates[1];
  process.stderr.write(
    [
      `Your repo: ${tasks} task${tasks === 1 ? "" : "s"} from its history (tests that fail before the commit and pass after it).`,
      `Models: ${a}, ${b} · ${repeat} run${repeat === 1 ? "" : "s"} a task · ${2 * runs} runs, ${total === undefined ? "cost unknown" : `about $${total.toFixed(2)} (a guess)`}.`,
      `Cap: --max-cost $${maxCost}; it stops before a model that would pass it.`,
      "",
    ].join("\n"),
  );
  if (total !== undefined && total > maxCost) {
    process.stderr.write(`The guess passes the cap: raise --max-cost, or lower --repeat.\n`);
    return 1;
  }
  if (options.yes !== true) {
    if (!process.stdin.isTTY) {
      process.stderr.write("Add --yes to start without a question.\n");
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question("Start? (y/N) ");
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) return 1;
  }
  const dir = join(process.cwd(), ".garuda", "evals", `advise-${newSessionId()}`);
  mkdirSync(dir, { recursive: true });
  const run = (model: string, label: string) =>
    runEvalCommand({ model, suite: "repo", repeat, shuffle: true, seed, outDir: join(dir, label) });
  await run(a, "a");
  const first = await loadReport(join(dir, "a"));
  const spent = costPerPass(first.results);
  const spentA = spent.kind === "unknown" ? undefined : spent.totalUsd;
  // The second model's cost from the first one's, by the price ratio.
  const ratio =
    prices[0] === undefined || prices[1] === undefined
      ? undefined
      : prices[1].input / prices[0].input;
  if (spentA !== undefined && ratio !== undefined && spentA * (1 + ratio) > maxCost) {
    process.stderr.write(
      `Stopped before ${b}: ${a} cost $${spentA.toFixed(2)}, so ${b} would take the total past $${maxCost}.\n`,
    );
    return 1;
  }
  await run(b, "b");
  const second = await loadReport(join(dir, "b"));
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
