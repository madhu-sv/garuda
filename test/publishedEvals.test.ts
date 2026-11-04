import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareReports, loadReport } from "../src/evals/compare.js";

/**
 * The reports of the blog post "Garuda against Claude Code, with intervals" (0.18), published in
 * docs/quality-baseline/evals/0.18/. They must hold no local path, and `eval compare` on them must
 * give the numbers that the post quotes.
 */

const DIR = join(import.meta.dirname, "..", "docs", "quality-baseline", "evals", "0.18");

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

/** A user's home, a macOS temp folder, a Linux home or a key. */
const PRIVATE = /\/Users\/|\/private\/var\/|\/var\/folders\/|\/home\/|sk-ant-/;

describe("the published 0.18 reports", () => {
  it("hold no local path or key, and every JSON file parses", () => {
    const all = files(DIR);
    expect(all.length).toBeGreaterThan(20);
    for (const file of all) {
      const text = readFileSync(file, "utf8");
      expect(PRIVATE.test(text), file).toBe(false);
      if (file.endsWith(".json")) expect(() => JSON.parse(text), file).not.toThrow();
    }
  });

  it("the private-path check finds a home path and a temp path", () => {
    // The negative control: the check above would pass on any text if the pattern were wrong.
    expect(PRIVATE.test('"sessionFile": "/Users/someone/dev/garuda/x.jsonl"')).toBe(true);
    expect(PRIVATE.test("See /private/var/folders/qc/abc/T/garuda-eval-x/target")).toBe(true);
    expect(PRIVATE.test('"sessionFile": ".garuda/evals/run/x.jsonl"')).toBe(false);
  });

  // The post's numbers: [A, B, cost ratio, low, high], each to two decimals.
  const quoted: [string, string, number, number, number][] = [
    ["heldout-haiku-garuda", "heldout-haiku-claude-code", 1.75, 1.54, 2.06],
    ["hard-haiku-without-graphify", "hard-haiku-with-graphify", 1.28, 1.19, 1.38],
    ["tune-haiku/heldout-empty", "tune-haiku/heldout-final", 0.81, 0.75, 0.88],
    ["heldout-sonnet-without-addendum", "heldout-sonnet-tuned-addendum", 0.87, 0.79, 0.95],
    ["heldout-sonnet-without-addendum", "heldout-sonnet-0.18-prompt", 0.9, 0.84, 0.96],
    ["heldout-haiku-garuda", "heldout-haiku-0.18-prompt", 0.88, 0.79, 1.02],
  ];

  it.each(quoted)("compare %s %s gives the post's cost ratio", async (a, b, value, low, high) => {
    const result = compareReports(await loadReport(join(DIR, a)), await loadReport(join(DIR, b)));
    if (!("comparison" in result)) throw new Error(result.problems.join("; "));
    const ratio = result.comparison.costRatio;
    expect(ratio).toBeDefined();
    const round = (n: number) => Math.round(n * 100) / 100;
    expect([round(ratio?.value ?? 0), round(ratio?.low ?? 0), round(ratio?.high ?? 0)]).toEqual([
      value,
      low,
      high,
    ]);
  });
});
