import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ADVISE_PARALLEL,
  continueCommand,
  costEstimate,
  type PastRun,
  pastCostPerRun,
  pastRuns,
  repricedCostPerRun,
  repricedSessionCost,
  reusableRun,
  sumKnown,
} from "../src/cli/advise.js";
import { progressHead } from "../src/cli/evalCommand.js";

const evals = mkdtempSync(join(tmpdir(), "garuda-advise-"));
afterAll(() => rmSync(evals, { recursive: true, force: true }));

const TASKS = { t1: "h1", t2: "h2" };
const result = (id: string, cost: number | undefined) => ({
  id,
  passed: true,
  steps: 3,
  costUsd: cost,
});

/** Write a report.json; `age` in seconds sets its time, so the newest is known. */
function put(folder: string, data: Record<string, unknown>, age: number) {
  const dir = join(evals, folder);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "report.json");
  writeFileSync(
    file,
    JSON.stringify({
      schema: 2,
      garuda: { version: "0.18.2", commit: "c1" },
      spec: "claude-haiku-5-5",
      suite: "repo",
      repeat: 1,
      seed: 1,
      tasks: TASKS,
      results: [result("t1", 0.1), result("t2", 0.3)],
      ...data,
    }),
  );
  const t = Date.now() / 1000 - age;
  utimesSync(file, t, t);
}

put("old-run", {}, 100);
put("advise-x/a", {}, 10);
put("leaky", { garuda: { version: "0.18.0", commit: "c1" } }, 1);
put("other-build", { garuda: { version: "0.18.2", commit: "c0" } }, 1);
put("other-hash", { tasks: { t1: "h1", t2: "changed" } }, 1);
put("repeat-2", { repeat: 2 }, 1);
put("short", { results: [result("t1", 0.1)] }, 1);
put("sonnet", { spec: "claude-sonnet-5-5", results: [result("t1", 1), result("t2", 3)] }, 50);
mkdirSync(join(evals, "broken"));
writeFileSync(join(evals, "broken", "report.json"), "{");

const want = {
  model: "claude-haiku-5-5",
  repeat: 1,
  seed: 1,
  tasks: TASKS,
  version: "0.18.2",
  commit: "c1",
};

describe("garuda advise: reuse of earlier runs", () => {
  const runs = pastRuns(evals);

  it("finds run folders and advise a/b folders, newest first, and skips a broken report", () => {
    expect(runs.map((r) => r.path.slice(evals.length + 1))).toContain("advise-x/a");
    expect(runs.find((r) => r.path.endsWith("broken"))).toBeUndefined();
    expect(pastRuns(join(evals, "none"))).toEqual([]);
  });

  it("reuses the newest run with the same model, tasks, repeat, seed and version", () => {
    expect(reusableRun(runs, want)?.path).toBe(join(evals, "advise-x", "a"));
    expect(reusableRun(runs, { ...want, model: "claude-sonnet-5-5" })?.path).toBe(
      join(evals, "sonnet"),
    );
  });

  it("refuses a run of another version or build, other task hashes, repeat, seed or with runs missing", () => {
    const only = (name: string) => runs.filter((r) => r.path.endsWith(name));
    expect(reusableRun(only("leaky"), want)).toBeUndefined();
    // Same version, another build: the user's broken 0.18.1 dev runs were reused this way.
    expect(reusableRun(only("other-build"), want)).toBeUndefined();
    expect(reusableRun(only("other-hash"), want)).toBeUndefined();
    expect(reusableRun(only("repeat-2"), want)).toBeUndefined();
    expect(reusableRun(only("short"), want)).toBeUndefined();
    expect(reusableRun(only("old-run"), { ...want, seed: 2 })).toBeUndefined();
    expect(
      reusableRun(only("old-run"), { ...want, tasks: { ...TASKS, t3: "h3" } }),
    ).toBeUndefined();
    expect(reusableRun(only("old-run"), want)?.path).toBe(join(evals, "old-run"));
  });
});

describe("garuda advise: the cost estimate", () => {
  const runs = pastRuns(evals);

  it("takes the mean cost of a run from earlier runs on the same tasks", () => {
    // haiku: old-run, advise-x/a, leaky, repeat-2 (0.1, 0.3 each) and short (0.1) on these hashes.
    expect(pastCostPerRun(runs, "claude-sonnet-5-5", TASKS)).toBeCloseTo(2);
    expect(pastCostPerRun(runs, "claude-haiku-5-5", TASKS)).toBeCloseTo(1.7 / 9);
    expect(pastCostPerRun(runs, "claude-opus-5-5", TASKS)).toBeUndefined();
  });

  it("uses history first, then the other model's requests repriced, then the guess", () => {
    const price = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
    expect(costEstimate(10, 0.2, { perRun: 2, from: "haiku" }, price)).toEqual({
      usd: 2,
      how: "from earlier runs",
    });
    expect(costEstimate(10, undefined, { perRun: 0.6, from: "haiku" }, price)).toEqual({
      usd: 6,
      how: "from haiku's requests at this model's prices",
    });
    expect(costEstimate(10, undefined, { perRun: undefined, from: "haiku" }, price).how).toBe(
      "a guess",
    );
    expect(costEstimate(10, undefined, { perRun: undefined, from: "h" }, undefined).usd).toBe(
      undefined,
    );
  });

  it("a sum with an unknown part is unknown", () => {
    expect(sumKnown([1, 2.5])).toBe(3.5);
    expect(sumKnown([])).toBe(0);
    expect(sumKnown([1, undefined])).toBeUndefined();
  });
});

describe("garuda advise: the continue command and progress", () => {
  it("prints a command with the same models, repeat and seed, and a cap rounded up", () => {
    expect(continueCommand("claude-haiku-5-5", "claude-sonnet-5-5", 1, 7, 11.2)).toBe(
      "garuda advise --models claude-haiku-5-5,claude-sonnet-5-5 --repeat 1 --seed 7 --max-cost 12",
    );
  });

  it("puts the label and the count before each result line, and nothing without a label", () => {
    expect(progressHead("haiku-5-5", 12, 30)).toBe("[haiku-5-5 12/30] ");
    expect(progressHead(undefined, 12, 30)).toBe("");
    expect(ADVISE_PARALLEL).toBe(4);
  });
});

describe("garuda advise: other runs' requests at this model's prices", () => {
  const dir = mkdtempSync(join(tmpdir(), "garuda-reprice-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const usage = (input: number, output: number) => ({
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  const assistant = (input: number, output: number) =>
    JSON.stringify({
      type: "assistant",
      step: 1,
      response: { content: [], stopReason: "end_turn", usage: usage(input, output) },
    });
  const file = (name: string, lines: string[]) => {
    const path = join(dir, name);
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  };
  // Haiku 5.5's real price: $0.1 a million input tokens, $0.5 for a prompt over 100 000 tokens.
  const haiku = {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    over: {
      tokens: 100_000,
      price: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    },
  };
  const sonnet = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
  const session = file("t1.jsonl", [
    JSON.stringify({ type: "start" }),
    assistant(200_000, 1_000),
    assistant(10_000, 1_000),
    JSON.stringify({ type: "side_usage", purpose: "review", usage: usage(50_000, 0) }),
  ]);

  it("prices each request on its own, so a long-prompt level applies only where it did", () => {
    // Haiku: 0.2 M at $0.5 + 1k out at $2.5, then 10k at $0.1 + 1k at $0.5, then 50k at $0.1.
    expect(repricedSessionCost(session, haiku)).toBeCloseTo(
      0.1 + 0.0025 + 0.001 + 0.0005 + 0.005,
      6,
    );
    // Sonnet: 0.26 M in at $2, 2k out at $10: about 5 times Haiku's cost, not 20 (the list ratio).
    expect(repricedSessionCost(session, sonnet)).toBeCloseTo(0.52 + 0.02, 6);
  });

  it("gives no cost for a missing file, a subagent, unreported tokens or a broken line", () => {
    expect(repricedSessionCost(join(dir, "none.jsonl"), sonnet)).toBeUndefined();
    const sub = JSON.stringify({ type: "tool_results", meta: [{ subagent: { sessionId: "c" } }] });
    expect(repricedSessionCost(file("s.jsonl", [assistant(1, 1), sub]), sonnet)).toBeUndefined();
    const unreported = JSON.stringify({ type: "unreported", tokens: 9 });
    expect(repricedSessionCost(file("u.jsonl", [unreported]), sonnet)).toBeUndefined();
    expect(repricedSessionCost(file("b.jsonl", ["{"]), sonnet)).toBeUndefined();
  });

  it("averages the runs of the other model, and finds a file next to a moved report", () => {
    const tasks = { t1: "h1" };
    const run: PastRun = {
      path: dir,
      model: "haiku",
      version: "0.18.2",
      commit: "c1",
      suite: "repo",
      repeat: 1,
      seed: 1,
      tasks,
      // Saved on another machine: the folder moved, the file name stays.
      results: [{ ...result("t1", 0.2), sessionFile: "/elsewhere/t1.jsonl" } as never],
      mtimeMs: 0,
    };
    expect(repricedCostPerRun([run], "haiku", tasks, sonnet)).toBeCloseTo(0.54, 6);
    expect(repricedCostPerRun([run], "sonnet", tasks, sonnet)).toBeUndefined();
    expect(repricedCostPerRun([run], "haiku", tasks, undefined)).toBeUndefined();
    const noFile: PastRun = { ...run, results: [result("t1", 0.2) as never] };
    expect(repricedCostPerRun([noFile], "haiku", tasks, sonnet)).toBeUndefined();
    // A run that cannot be priced is left out while it is at most half.
    const half: PastRun = { ...run, results: [...run.results, ...noFile.results] };
    expect(repricedCostPerRun([half], "haiku", tasks, sonnet)).toBeCloseTo(0.54, 6);
    const most: PastRun = { ...run, results: [...half.results, ...noFile.results] };
    expect(repricedCostPerRun([most], "haiku", tasks, sonnet)).toBeUndefined();
  });
});
