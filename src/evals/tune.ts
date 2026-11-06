import { readFile } from "node:fs/promises";
import { compareReports, formatComparison, type LoadedReport } from "./compare.js";
import { taskHash } from "./report.js";
import { costPerPass } from "./stats.js";
import type { EvalResult, EvalTask } from "./types.js";

/**
 * `garuda eval tune` (0.17, T11d; docs/lld/eval-evidence.md): a proposer model edits one prompt
 * addendum; an edit stays only when the dev score improves; the held-out split is measured once at
 * the end. The loop gets its model calls as functions, so the tests run it with fakes.
 */

/** The addendum's size limit. */
export const ADDENDUM_MAX_CHARS = 4_000;

/** Lines of a failed check that the proposer sees. */
const CHECK_TAIL_LINES = 40;

/**
 * Phrases that an addendum must not hold: they ask the agent to get around the grading. The checks
 * and protected files still decide the score; this stops such a text before it costs a run.
 */
const REJECTED: readonly RegExp[] = [
  /\b(skip|disable|ignore|bypass|weaken)\b[^.\n]{0,40}\b(tests?|checks?|assert\w*|sandbox|protect\w*)/i,
  /\b(edit|change|modify|delete|remove|rewrite)\b[^.\n]{0,40}\b(the )?(tests?|test files?|checks?|protected files?)\b/i,
  /\boutside_sandbox\b/i,
  /\b(hard-?code|special-?case)\b[^.\n]{0,40}\b(expected|test|check)/i,
  /\.check\//i,
];

/**
 * Read an addendum file for `--addendum` or `eval tune`. A missing file is an empty addendum when
 * `missingIsEmpty` (tune starts from nothing); a text over the limit is refused.
 */
export async function readAddendum(
  path: string,
  missingIsEmpty = false,
): Promise<{ text: string } | { problem: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (missingIsEmpty && (error as NodeJS.ErrnoException).code === "ENOENT") return { text: "" };
    return { problem: `--addendum ${path}: ${(error as Error).message}` };
  }
  if (text.length > ADDENDUM_MAX_CHARS) {
    return {
      problem: `--addendum ${path}: ${text.length} characters; the limit is ${ADDENDUM_MAX_CHARS}.`,
    };
  }
  return { text };
}

/** Why a proposed addendum is refused before any run, or undefined. */
export function rejectReason(text: string): string | undefined {
  if (text.trim() === "") return "the addendum is empty";
  if (text.length > ADDENDUM_MAX_CHARS) {
    return `the addendum has ${text.length} characters; the limit is ${ADDENDUM_MAX_CHARS}`;
  }
  // A clause ends at . ; ! ? before a space, or at a line end: ".check/" stays whole.
  for (const clause of text.split(/[.;!?](?=\s|$)|\n/)) {
    for (const pattern of REJECTED) {
      const hit = pattern.exec(clause);
      // "Never modify tests to make them pass" is a rule for the agent, not a way around the
      // grading (the user's first tune run refused it): a negation before the phrase clears it.
      // The negation may also sit inside the match: "change without editing the tests".
      if (hit === null || NEGATION.test(clause.slice(0, hit.index + hit[0].length))) continue;
      return `the addendum asks to get around the grading ("${hit[0]}")`;
    }
  }
  return undefined;
}

/** A word that turns the rest of the clause into a prohibition. */
const NEGATION = /\b(never|not|don't|do not|no|without)\b/i;

export interface Decision {
  kept: boolean;
  /** One line for the history and the log. */
  reason: string;
  passesCurrent: number;
  passesCandidate: number;
  runs: number;
  /** Candidate / current cost per accepted change, with its paired interval. */
  costRatio?: { value: number; low: number; high: number };
}

/** The runs of each task, in first-seen order. */
function groupRuns(results: readonly EvalResult[]): Map<string, EvalResult[]> {
  const out = new Map<string, EvalResult[]>();
  for (const r of results) out.set(r.id, [...(out.get(r.id) ?? []), r]);
  return out;
}

/**
 * A report of one score for `compareReports`. With the tasks, it carries their hashes, so the
 * comparison checks that both arms ran the same tasks (the first tune run's note said they had none).
 */
const asReport = (
  path: string,
  results: readonly EvalResult[],
  tasks?: readonly EvalTask[],
): LoadedReport => ({
  path,
  schema: 2,
  model: undefined,
  seed: undefined,
  tasks:
    tasks === undefined ? undefined : Object.fromEntries(tasks.map((t) => [t.id, taskHash(t)])),
  results: [...results],
});

/**
 * Keep or drop a candidate (the user's rule, 2026-10-30): no task may go from k of k to 0 of k;
 * then keep it when it passes at least `margin` more runs, or as many runs with a cost per
 * accepted change whose paired interval (candidate / current) is below ×1.0.
 */
export function decide(
  current: readonly EvalResult[],
  candidate: readonly EvalResult[],
  options: { margin: number; seed: number },
): Decision {
  const passesCurrent = current.filter((r) => r.passed).length;
  const passesCandidate = candidate.filter((r) => r.passed).length;
  const runs = candidate.length;
  const base = { passesCurrent, passesCandidate, runs };
  const before = groupRuns(current);
  const after = groupRuns(candidate);
  const lost = [...before.entries()]
    .filter(([, rs]) => rs.length > 0 && rs.every((r) => r.passed))
    .filter(([id]) => {
      const now = after.get(id) ?? [];
      return now.length > 0 && now.every((r) => !r.passed);
    })
    .map(([id]) => id);
  if (lost.length > 0) {
    return {
      ...base,
      kept: false,
      reason: `dropped: ${lost.join(", ")} went from all runs passed to none`,
    };
  }
  const compared = compareReports(asReport("current", current), asReport("candidate", candidate), {
    seed: options.seed,
  });
  const ratio =
    "problems" in compared || compared.comparison.costRatio === undefined
      ? undefined
      : compared.comparison.costRatio;
  const costRatio =
    ratio === undefined ? undefined : { value: ratio.value, low: ratio.low, high: ratio.high };
  const withCost = costRatio === undefined ? base : { ...base, costRatio };
  const gain = passesCandidate - passesCurrent;
  if (gain >= options.margin) {
    return {
      ...withCost,
      kept: true,
      reason: `kept: ${gain} more passing run(s) (margin ${options.margin})`,
    };
  }
  if (gain >= 0 && costRatio !== undefined && costRatio.high < 1) {
    return {
      ...withCost,
      kept: true,
      reason: `kept: as many passes or more, and cost per accepted change ×${costRatio.value.toFixed(2)} (95% interval ×${costRatio.low.toFixed(2)} to ×${costRatio.high.toFixed(2)})`,
    };
  }
  const cost =
    costRatio === undefined
      ? "cost ratio unknown"
      : `cost ×${costRatio.value.toFixed(2)} (×${costRatio.low.toFixed(2)} to ×${costRatio.high.toFixed(2)})`;
  return {
    ...withCost,
    kept: false,
    reason: `dropped: ${gain >= 0 ? "+" : ""}${gain} passing run(s) (margin ${options.margin}), ${cost}`,
  };
}

export interface HistoryEntry {
  round: number;
  version: string;
  reason: string;
  decision?: Decision;
  rejected?: string;
  /** Why the round's first text was refused, when the retry gave the scored one. */
  refusedFirst?: string;
  costUsd: number;
}

/**
 * The proposer's input: the current addendum, the dev runs that failed (or, when all passed, what
 * each task cost), and the history. Built from dev results only: the held-out split never gets
 * here.
 */
export function proposerInput(
  addendum: string,
  tasks: readonly EvalTask[],
  results: readonly EvalResult[],
  history: readonly HistoryEntry[],
): string {
  const prompts = new Map(tasks.map((t) => [t.id, t.prompt]));
  const lines: string[] = [
    "# The current addendum",
    "",
    addendum.trim() === "" ? "(empty)" : addendum.trim(),
    "",
  ];
  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    lines.push(`# Failed runs (${failed.length} of ${results.length})`, "");
    for (const r of failed) {
      const tail = (r.reason ?? "").split("\n").slice(-CHECK_TAIL_LINES).join("\n");
      lines.push(
        `## ${r.id} (run ${r.attempt ?? 1}): ${r.stopReason}, ${r.steps} steps`,
        "",
        "Task prompt:",
        prompts.get(r.id) ?? "(unknown)",
        "",
        "Why it failed (last lines):",
        "```",
        tail,
        "```",
        ...(r.unexpected !== undefined && r.unexpected.length > 0
          ? ["", `Unexpected changes: ${r.unexpected.join(", ")}`]
          : []),
        "",
      );
    }
  } else {
    lines.push(`# Every run passed (${results.length}). Lower the cost: what each task took`, "");
    for (const [id, rs] of groupRuns(results)) {
      const mean = (f: (r: EvalResult) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
      const costliest = [...rs].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))[0];
      lines.push(
        `- ${id}: ${mean((r) => r.steps).toFixed(1)} steps, ${Math.round(mean((r) => r.tokens))} tokens, $${mean((r) => r.costUsd ?? 0).toFixed(4)} a run; tools of the costliest run: ${(costliest?.tools ?? []).join(", ") || "(none recorded)"}`,
      );
    }
    lines.push("");
  }
  if (history.length > 0) {
    lines.push("# Earlier proposals", "");
    for (const h of history) {
      lines.push(
        `- round ${h.round} (${h.version}): ${h.rejected === undefined ? (h.decision?.reason ?? "") : `rejected before a run: ${h.rejected}`}. The proposer's reason: ${h.reason}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** The proposer's instructions. */
export const PROPOSER_SYSTEM = [
  "You improve a coding agent. The agent gets a short text, the addendum, at the end of its system",
  "prompt. You see the current addendum and the agent's results on development tasks. Write a",
  "complete new addendum that should make the agent pass more tasks, or pass them at a lower cost.",
  "",
  "Rules:",
  `- At most ${ADDENDUM_MAX_CHARS} characters. General advice about how to work, not about one task:`,
  "  the addendum is measured later on tasks you never see.",
  "- Never tell the agent to skip, weaken or edit tests or checks, to touch protected files, or to",
  "  leave the sandbox. Such a text is refused without a run.",
  "",
  "Answer in exactly this form:",
  "<addendum>",
  "the complete new addendum",
  "</addendum>",
  "<reason>one paragraph: what you changed and why</reason>",
].join("\n");

export interface Proposal {
  addendum: string;
  reason: string;
  /** The proposer call's cost; undefined when unknown. */
  costUsd: number | undefined;
}

/** Read the proposer's answer. Undefined when it is not in the form. */
export function parseProposal(text: string): { addendum: string; reason: string } | undefined {
  const addendum = /<addendum>\n?([\s\S]*?)\n?<\/addendum>/.exec(text)?.[1];
  const reason = /<reason>([\s\S]*?)<\/reason>/.exec(text)?.[1];
  if (addendum === undefined) return undefined;
  return { addendum: addendum.trim(), reason: (reason ?? "").trim() };
}

export interface TuneOptions {
  /** The starting addendum ("" for none). */
  start: string;
  devTasks: readonly EvalTask[];
  heldOutTasks: readonly EvalTask[];
  /** Run these tasks `repeat` times each with this addendum; the results of all runs. */
  score: (
    addendum: string,
    tasks: readonly EvalTask[],
    repeat: number,
    label: string,
  ) => Promise<EvalResult[]>;
  propose: (input: string) => Promise<Proposal>;
  rounds: number;
  repeat: number;
  heldoutRepeat: number;
  margin: number;
  maxCostUsd: number;
  seed: number;
  /** Save a file in the run's folder. */
  save: (name: string, text: string) => Promise<void>;
  log: (line: string) => void;
}

export interface TuneResult {
  final: string;
  history: HistoryEntry[];
  spentUsd: number;
  stopped: "rounds" | "cost" | "unknown cost";
  /** The held-out comparison: empty addendum (A) against the final one (B). */
  heldOut?: string;
}

const costOf = (results: readonly EvalResult[]): number | undefined => {
  const c = costPerPass(results);
  if (c.kind === "unknown") return undefined;
  return results.reduce((s, r) => s + (r.costUsd ?? 0), 0);
};

/** The loop (docs/lld/eval-evidence.md, "One round"). */
export async function tune(options: TuneOptions): Promise<TuneResult> {
  const history: HistoryEntry[] = [];
  let spent = 0;
  let current = options.start;
  let version = 0;
  await options.save("v0.md", current);
  options.log(`Scoring v0 on ${options.devTasks.length} dev task(s) × ${options.repeat}.`);
  let currentResults = await options.score(current, options.devTasks, options.repeat, "v0");
  let lastScoreCost = costOf(currentResults);
  if (lastScoreCost === undefined) {
    return { final: current, history, spentUsd: spent, stopped: "unknown cost" };
  }
  spent += lastScoreCost;
  let stopped: TuneResult["stopped"] = "rounds";
  let lastProposalCost = 0;

  for (let round = 1; round <= options.rounds; round++) {
    // The next round costs about one proposal and one score: stop before it passes the budget.
    if (spent + lastScoreCost + lastProposalCost > options.maxCostUsd) {
      stopped = "cost";
      options.log(
        `Stopping before round ${round}: $${spent.toFixed(2)} spent, and the next round would pass --max-cost $${options.maxCostUsd}.`,
      );
      break;
    }
    const input = proposerInput(current, options.devTasks, currentResults, history);
    const name = `v${round}`;
    await options.save(`${name}.input.md`, input);
    let proposal = await options.propose(input);
    if (proposal.costUsd === undefined) {
      stopped = "unknown cost";
      break;
    }
    let proposalCost = proposal.costUsd;
    let rejected = rejectReason(proposal.addendum);
    let refusedFirst: string | undefined;
    if (rejected !== undefined) {
      // One more try in the same round, with the reason: a refused text costs a proposal, not a
      // round (the user's first tune run lost two of three rounds to refused texts).
      refusedFirst = rejected;
      await options.save(`${name}.refused.md`, proposal.addendum);
      options.log(`Round ${round}: ${name} refused (${rejected}); asking once more.`);
      const again = await options.propose(
        `${input}\n# Your last answer was refused\n\n${rejected}. Write the complete addendum again without that phrase. Do not tell the agent to skip, change or delete tests or checks, even as an example of what to avoid.\n`,
      );
      if (again.costUsd === undefined) {
        stopped = "unknown cost";
        break;
      }
      proposalCost += again.costUsd;
      proposal = again;
      rejected = rejectReason(proposal.addendum);
    }
    spent += proposalCost;
    lastProposalCost = proposalCost;
    await options.save(`${name}.md`, proposal.addendum);
    if (rejected !== undefined) {
      history.push({
        round,
        version: name,
        reason: proposal.reason,
        rejected,
        costUsd: proposalCost,
      });
      options.log(`Round ${round}: ${name} rejected before a run: ${rejected}.`);
      continue;
    }
    options.log(`Round ${round}: scoring ${name}.`);
    const candidate = await options.score(
      proposal.addendum,
      options.devTasks,
      options.repeat,
      name,
    );
    const scoreCost = costOf(candidate);
    if (scoreCost === undefined) {
      stopped = "unknown cost";
      break;
    }
    spent += scoreCost;
    lastScoreCost = scoreCost;
    const decision = decide(currentResults, candidate, {
      margin: options.margin,
      seed: options.seed,
    });
    history.push({
      round,
      version: name,
      reason: proposal.reason,
      decision,
      costUsd: proposalCost + scoreCost,
      ...(refusedFirst === undefined ? {} : { refusedFirst }),
    });
    options.log(`Round ${round}: ${name} ${decision.reason}.`);
    if (decision.kept) {
      current = proposal.addendum;
      currentResults = candidate;
      version = round;
    }
    await options.save("history.json", `${JSON.stringify(history, null, 2)}\n`);
  }
  await options.save("history.json", `${JSON.stringify(history, null, 2)}\n`);
  await options.save("final.md", current);

  // The held-out measurement: once, at the end; it decides nothing.
  let heldOut: string | undefined;
  if (options.heldOutTasks.length > 0 && version > 0) {
    options.log(
      `Held-out: the empty addendum (A) against v${version} (B), × ${options.heldoutRepeat}.`,
    );
    const a = await options.score("", options.heldOutTasks, options.heldoutRepeat, "heldout-empty");
    const b = await options.score(
      current,
      options.heldOutTasks,
      options.heldoutRepeat,
      "heldout-final",
    );
    spent += (costOf(a) ?? 0) + (costOf(b) ?? 0);
    const ra = asReport("held-out, empty addendum", a, options.heldOutTasks);
    const rb = asReport(`held-out, v${version}`, b, options.heldOutTasks);
    const compared = compareReports(ra, rb, { seed: options.seed });
    heldOut =
      "problems" in compared
        ? compared.problems.join("\n")
        : formatComparison(ra, rb, compared.comparison);
    await options.save("heldout.txt", `${heldOut}\n`);
  } else if (version === 0) {
    options.log("No version was kept: no held-out measurement.");
  }
  return {
    final: current,
    history,
    spentUsd: spent,
    stopped,
    ...(heldOut === undefined ? {} : { heldOut }),
  };
}
