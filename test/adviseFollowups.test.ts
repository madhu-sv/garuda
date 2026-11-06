import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ADVISE_PARALLEL,
  continueCommand,
  costEstimate,
  pastCostPerRun,
  pastRuns,
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
      garuda: { version: "0.18.2" },
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
put("leaky", { garuda: { version: "0.18.0" } }, 1);
put("other-hash", { tasks: { t1: "h1", t2: "changed" } }, 1);
put("repeat-2", { repeat: 2 }, 1);
put("short", { results: [result("t1", 0.1)] }, 1);
put("sonnet", { spec: "claude-sonnet-5-5", results: [result("t1", 1), result("t2", 3)] }, 50);
mkdirSync(join(evals, "broken"));
writeFileSync(join(evals, "broken", "report.json"), "{");

const want = { model: "claude-haiku-5-5", repeat: 1, seed: 1, tasks: TASKS, version: "0.18.2" };

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

  it("refuses a run of another version, other task hashes, repeat, seed or with runs missing", () => {
    const only = (name: string) => runs.filter((r) => r.path.endsWith(name));
    expect(reusableRun(only("leaky"), want)).toBeUndefined();
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

  it("uses history first, then the other model's history by price, then the guess", () => {
    const price = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
    expect(costEstimate(10, 0.2, { perRun: 2, priceRatio: 3 }, price)).toEqual({
      usd: 2,
      how: "from earlier runs",
    });
    const scaled = costEstimate(10, undefined, { perRun: 0.2, priceRatio: 3 }, price);
    expect(scaled.usd).toBeCloseTo(6);
    expect(scaled.how).toBe("from the other model's runs, by price");
    expect(costEstimate(10, undefined, { perRun: undefined, priceRatio: 3 }, price).how).toBe(
      "a guess",
    );
    expect(costEstimate(10, undefined, { perRun: 1, priceRatio: undefined }, undefined).usd).toBe(
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
