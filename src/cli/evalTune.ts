import { mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { reportV2 } from "../evals/report.js";
import { formatReport, runEvals } from "../evals/runner.js";
import { DEFAULT_SEED, shuffled } from "../evals/stats.js";
import { EVAL_SUITES, HELD_OUT_TASKS, requiredToolchains } from "../evals/suites.js";
import { checkToolchains, TOOLCHAINS } from "../evals/toolchains.js";
import {
  PROPOSER_SYSTEM,
  type Proposal,
  parseProposal,
  readAddendum,
  tune,
} from "../evals/tune.js";
import type { EvalResult, EvalTask } from "../evals/types.js";
import { costOf } from "../model/pricing.js";
import {
  chooseModel,
  keepProviderKeys,
  loadModelsConfig,
  NO_MODEL,
  type ResolvedModel,
  resolveModel,
} from "../model/providers.js";
import type { ModelResponse } from "../model/types.js";
import { createExecutor } from "../sandbox/index.js";
import { newSessionId } from "../session/store.js";

/** `garuda eval tune` (0.17, T11d; docs/lld/eval-evidence.md). */
export interface EvalTuneOptions {
  /** --addendum <file>: the starting text (a missing file starts empty). Garuda never edits it. */
  addendum: string;
  /** --proposer <model>: default claude-opus-5-5 (the user's decision). */
  proposer?: string;
  /** -m: the agent's model. */
  model?: string;
  rounds?: number;
  repeat?: number;
  heldoutRepeat?: number;
  margin?: number;
  maxCost?: number;
  seed?: number;
  /** -s: dev suites. Default basic, hard and medium. */
  suite?: string[];
  /** --yes: start without the question. */
  yes?: boolean;
  /** --parallel <n>: runs at the same time in each score (default 4). */
  parallel?: number;
}

/** Runs at the same time (0.17): one at a time took about 16 minutes a score in the first run. */
export const DEFAULT_TUNE_PARALLEL = 4;

/** The progress line of one run: "[v1 23/78] ✓ hard-rename (6 steps)". */
export function progressLine(label: string, done: number, total: number, r: EvalResult): string {
  return `[${label} ${done}/${total}] ${r.passed ? "✓" : "✗"} ${r.id} (${r.steps} steps)${r.passed ? "" : `: ${(r.reason ?? r.stopReason).split("\n")[0]}`}`;
}

export const DEFAULT_PROPOSER = "claude-opus-5-5";
export const DEFAULT_TUNE_SUITES = ["basic", "hard", "medium"] as const;

const whole = (value: number | undefined, fallback: number, min: number) => {
  const v = value ?? fallback;
  return Number.isInteger(v) && v >= min ? v : undefined;
};

/** One proposer request, with no tools; the cost from the model's price. */
export async function askProposer(
  proposer: ResolvedModel,
  input: string,
): Promise<Proposal | string> {
  const client = await proposer.create();
  let response: ModelResponse | undefined;
  for await (const event of client.stream({
    system: PROPOSER_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text: input }] }],
    tools: [],
    maxTokens: 8_000,
  })) {
    if (event.type === "response") response = event.response;
  }
  if (response === undefined) return "the proposer gave no answer";
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
  const parsed = parseProposal(text);
  if (parsed === undefined) return "the proposer's answer has no <addendum> block";
  const price = proposer.info.price;
  return {
    ...parsed,
    costUsd:
      price === undefined ? undefined : costOf(response.usage, price, response.priceFactor ?? 1),
  };
}

export async function runEvalTune(options: EvalTuneOptions): Promise<number> {
  const rounds = whole(options.rounds, 5, 1);
  const repeat = whole(options.repeat, 3, 1);
  const heldoutRepeat = whole(options.heldoutRepeat, 5, 1);
  const margin = whole(options.margin, 2, 1);
  const seed = whole(options.seed, DEFAULT_SEED, 0);
  const parallel = whole(options.parallel, DEFAULT_TUNE_PARALLEL, 1);
  const maxCost = options.maxCost ?? 20;
  if (
    rounds === undefined ||
    repeat === undefined ||
    heldoutRepeat === undefined ||
    margin === undefined ||
    seed === undefined ||
    parallel === undefined ||
    !(maxCost > 0)
  ) {
    process.stderr.write(
      "--rounds, --repeat, --heldout-repeat, --margin and --parallel must be whole numbers of 1 or more, --seed 0 or more, and --max-cost above 0.\n",
    );
    return 1;
  }
  const suites = options.suite ?? [...DEFAULT_TUNE_SUITES];
  const devTasks: EvalTask[] = [];
  for (const name of suites) {
    const tasks = EVAL_SUITES[name];
    if (tasks === undefined) {
      process.stderr.write(`Unknown suite ${name}. Use: ${Object.keys(EVAL_SUITES).join(", ")}.\n`);
      return 1;
    }
    devTasks.push(...tasks);
  }
  const start = await readAddendum(options.addendum, true);
  if ("problem" in start) {
    process.stderr.write(`${start.problem}\n`);
    return 1;
  }

  const models = await loadModelsConfig();
  if (models.problem !== undefined) {
    process.stderr.write(`${models.problem}\n`);
    return 1;
  }
  const modelId = chooseModel(models.config, options.model);
  if (!modelId) {
    process.stderr.write(`${NO_MODEL}\n`);
    return 1;
  }
  let agent: ResolvedModel;
  let proposer: ResolvedModel;
  try {
    agent = resolveModel(modelId, models.config);
    proposer = resolveModel(options.proposer ?? DEFAULT_PROPOSER, models.config);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  const { assertModelAllowedByPolicy, loadTeamPolicy } = await import("../permissions/policy.js");
  let team: Awaited<ReturnType<typeof loadTeamPolicy>>;
  try {
    team = await loadTeamPolicy();
    assertModelAllowedByPolicy(team?.policy, agent.spec);
    assertModelAllowedByPolicy(team?.policy, proposer.spec);
  } catch (error) {
    process.stderr.write(`Team policy: ${(error as Error).message}\n`);
    return 1;
  }
  const warning = await keepProviderKeys([agent.def.apiKeyEnv, proposer.def.apiKeyEnv]);
  if (warning !== undefined) process.stderr.write(`${warning}\n`);

  const missing = (
    await checkToolchains(requiredToolchains([...devTasks, ...HELD_OUT_TASKS]))
  ).filter((s) => !s.ok);
  if (missing.length > 0) {
    for (const status of missing) process.stderr.write(`${TOOLCHAINS[status.id].hint}\n`);
    return 1;
  }

  const perScore = devTasks.length * repeat;
  const heldOutRuns = 2 * HELD_OUT_TASKS.length * heldoutRepeat;
  process.stderr.write(
    [
      `Tuning ${options.addendum} (${start.text.length} characters) with ${agent.spec}; ${proposer.spec} proposes.`,
      `Dev: ${devTasks.length} task(s) from ${suites.join(", ")} × ${repeat} = ${perScore} runs a score, ${parallel} at a time; up to ${rounds + 1} scores.`,
      `Held-out: ${HELD_OUT_TASKS.length} task(s) × ${heldoutRepeat}, twice, at the end (${heldOutRuns} runs), if a version is kept.`,
      `Keep rule: +${margin} passing runs, or as many with a lower cost per accepted change (interval below ×1.0).`,
      `Budget: --max-cost $${maxCost}; the loop stops before a round that would pass it.`,
      `Garuda changes no file outside the run's folder; ${options.addendum} stays as it is.`,
      "",
    ].join("\n"),
  );
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

  const { executor, notice } = createExecutor("auto");
  if (notice !== undefined) process.stderr.write(`${notice}\n`);
  const dir = join(process.cwd(), ".garuda", "evals", `tune-${newSessionId()}`);
  mkdirSync(dir, { recursive: true });

  const score = async (
    addendum: string,
    tasks: readonly EvalTask[],
    k: number,
    label: string,
  ): Promise<EvalResult[]> => {
    const listed = tasks.flatMap((t) => Array.from({ length: k }, () => t));
    const outDir = join(dir, label);
    let done = 0;
    const results = await runEvals(
      shuffled(listed, seed),
      {
        parallel,
        modelId: agent.spec,
        model: () => agent.create(),
        modelInfo: agent.info,
        ...(agent.maxTokens === undefined ? {} : { maxTokens: agent.maxTokens }),
        ...(team === undefined ? {} : { policy: team.policy }),
        outDir,
        executor: executor.name === "host" ? "host" : "os",
        ...(addendum === "" ? {} : { addendum }),
      },
      (r) => {
        done++;
        process.stderr.write(`${progressLine(label, done, listed.length, r)}\n`);
      },
    );
    writeFileSync(
      join(outDir, "report.json"),
      `${JSON.stringify(
        {
          ...(await reportV2(
            {
              model: agent.spec,
              provider: agent.provider,
              executor: executor.name,
              isolation: executor.isolation,
              seed,
              shuffle: true,
              split: label.startsWith("heldout") ? "heldout" : "dev",
              ...(addendum === "" ? {} : { addendum: { file: `${label}.md`, text: addendum } }),
            },
            tasks,
            results,
          )),
          results,
        },
        null,
        2,
      )}\n`,
    );
    process.stderr.write(`\n${label}:\n${formatReport(results, { seed })}\n\n`);
    return results;
  };

  const result = await tune({
    start: start.text,
    devTasks,
    heldOutTasks: HELD_OUT_TASKS,
    score,
    propose: async (input) => {
      const answer = await askProposer(proposer, input);
      if (typeof answer === "string") {
        // A bad answer costs a round but runs nothing: the text "" is refused before a run.
        return { addendum: "", reason: answer, costUsd: 0 };
      }
      return answer;
    },
    rounds,
    repeat,
    heldoutRepeat,
    margin,
    maxCostUsd: maxCost,
    seed,
    save: (name, text) => writeFile(join(dir, name), text),
    log: (line) => process.stderr.write(`${line}\n`),
  });

  const kept = result.history.filter((h) => h.decision?.kept === true);
  process.stdout.write(
    [
      "",
      `Rounds: ${result.history.length}; kept: ${kept.length === 0 ? "none" : kept.map((h) => h.version).join(", ")}. Spent about $${result.spentUsd.toFixed(2)}${result.stopped === "rounds" ? "" : ` (stopped: ${result.stopped})`}.`,
      ...(result.heldOut === undefined
        ? []
        : ["", "Held-out (the only number to quote):", result.heldOut]),
      "",
      `The final addendum: ${join(dir, "final.md")}. To use it, copy it into GARUDA.md yourself.`,
      `Every version, the proposer's inputs and history.json: ${dir}`,
      "",
    ].join("\n"),
  );
  return 0;
}
