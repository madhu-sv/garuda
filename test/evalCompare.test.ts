import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  compareReports,
  formatComparison,
  type LoadedReport,
  loadReport,
  parseReport,
} from "../src/evals/compare.js";
import { formatReport } from "../src/evals/runner.js";
import type { EvalResult } from "../src/evals/types.js";

/** `garuda eval compare` (0.17, T11a part 2; docs/lld/eval-evidence.md). */

const run = (id: string, passed: boolean, over: Partial<EvalResult> = {}): EvalResult => ({
  id,
  title: id,
  passed,
  stopReason: "done",
  steps: 5,
  tokens: 1000,
  costUsd: 0.01,
  durationMs: 2000,
  ...over,
});

/** A report with `passes[i]` of `runs` passing for task t<i>. */
function report(path: string, passes: number[], runs = 3, over: Partial<LoadedReport> = {}) {
  const results = passes.flatMap((p, i) =>
    Array.from({ length: runs }, (_, k) => run(`t${i}`, k < p, { attempt: k + 1 })),
  );
  return {
    path,
    schema: 2,
    model: path,
    seed: 1,
    tasks: Object.fromEntries(passes.map((_, i) => [`t${i}`, `hash${i}`])),
    results,
    ...over,
  } satisfies LoadedReport;
}

const ok = (r: ReturnType<typeof compareReports>) => {
  if ("problems" in r) throw new Error(r.problems.join(" "));
  return r.comparison;
};

describe("compare: the paired interval", () => {
  it("pairing keeps the task difficulty out: B gains on every hard task, so B passes more", () => {
    // Five easy tasks (both 3/3) and five hard ones (A 0/3, B 1/3).
    const a = report("a", [3, 3, 3, 3, 3, 0, 0, 0, 0, 0]);
    const b = report("b", [3, 3, 3, 3, 3, 1, 1, 1, 1, 1]);
    const c = ok(compareReports(a, b, { seed: 1 }));
    expect(c.rateA).toBeCloseTo(0.5);
    expect(c.rateB).toBeCloseTo(20 / 30);
    expect(c.difference.value).toBeCloseTo(1 / 6);
    expect(c.difference.low).toBeGreaterThan(0);
    expect(c.verdict).toBe("B passes more");
  });

  it("the same results give no clear difference; a clear loss reads as B passes less", () => {
    const a = report("a", [3, 2, 1, 0, 3, 2, 1, 0, 3, 2]);
    const same = ok(compareReports(a, report("b", [3, 2, 1, 0, 3, 2, 1, 0, 3, 2])));
    expect(same.difference).toMatchObject({ value: 0, low: 0, high: 0 });
    expect(same.verdict).toBe("no clear difference");
    const worse = ok(
      compareReports(report("a", Array(10).fill(3)), report("b", Array(10).fill(0))),
    );
    expect(worse.verdict).toBe("B passes less");
    // A small, noisy difference: the interval contains 0.
    const noisy = ok(
      compareReports(
        report("a", [3, 0, 2, 1, 3, 0, 2, 1, 3, 0]),
        report("b", [2, 1, 3, 0, 3, 1, 2, 1, 3, 0]),
      ),
    );
    expect(noisy.difference.low).toBeLessThan(0);
    expect(noisy.difference.high).toBeGreaterThan(0);
    expect(noisy.verdict).toBe("no clear difference");
  });

  it("the same seed gives the same interval", () => {
    const a = report("a", [3, 0, 2, 1, 3, 0, 2, 1, 3, 0]);
    const b = report("b", [3, 1, 3, 1, 3, 1, 2, 2, 3, 0]);
    expect(ok(compareReports(a, b, { seed: 5 })).difference).toEqual(
      ok(compareReports(a, b, { seed: 5 })).difference,
    );
  });
});

describe("compare: what it refuses and what it notes", () => {
  it("refuses reports of different tasks, or of tasks whose hashes changed", () => {
    const a = report("a", [3, 3]);
    const fewer = compareReports(a, report("b", [3]));
    expect("problems" in fewer && fewer.problems[0]).toMatch(/different tasks; only in A: t1/);
    const changed = compareReports(
      a,
      report("b", [3, 3], 3, { tasks: { t0: "hash0", t1: "other" } }),
    );
    expect("problems" in changed && changed.problems[0]).toMatch(
      /hashes differ\): t1\. Run both arms/,
    );
  });

  it("a report before 0.17 has no task hashes: it compares, with a note", () => {
    const c = ok(
      compareReports(
        report("old", [3, 3], 3, { tasks: undefined, schema: 1 }),
        report("b", [3, 3]),
      ),
    );
    expect(c.notes.join(" ")).toMatch(/old has no task hashes/);
  });

  it("notes few tasks, different seeds and fewer than 3 runs", () => {
    const c = ok(compareReports(report("a", [1, 1], 1), report("b", [1, 1], 1, { seed: 9 })));
    expect(c.notes.join("\n")).toMatch(
      /Only 2 tasks: with fewer than 10 tasks the interval is a rough guide/,
    );
    expect(c.notes.join("\n")).toMatch(/different seeds \(1 and 9\)/);
    expect(c.notes.join("\n")).toMatch(/fewer than 3 runs/);
  });

  it("prints the rows, the rates, the verdict and each arm's cost, scope and time", () => {
    const a = report("a", [3, 0, 3, 0, 3, 0, 3, 0, 3, 0]);
    const b = report("b", [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
    const text = formatComparison(a, b, ok(compareReports(a, b)));
    expect(text).toContain("t1    0/3      3/3");
    expect(text).toMatch(
      /Pass rate over all attempts: A 50%, B 100%; B − A \+50 pts \(95% paired interval/,
    );
    expect(text).toContain("Verdict: B passes more.");
    expect(text).toContain(
      "A: cost per accepted change $0.0200 · unexpected changes not measured · median time 2 s",
    );
  });
});

const temp = mkdtempSync(join(tmpdir(), "garuda-compare-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("reading reports", () => {
  it("reads a report.json or its run folder; version 1 has no hashes", async () => {
    const dir = join(temp, "run1");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "report.json"),
      JSON.stringify({ model: "m", results: [run("a", true)] }),
    );
    const v1 = await loadReport(dir);
    expect(v1).toMatchObject({ schema: 1, model: "m", tasks: undefined });
    const v2 = parseReport(
      { schema: 2, spec: "s", seed: 3, tasks: { a: "h" }, results: [run("a", true)] },
      "x",
    );
    expect(v2).toMatchObject({ schema: 2, model: "s", seed: 3, tasks: { a: "h" } });
    expect(() => parseReport({ hello: 1 }, "bad.json")).toThrow(/not an eval report/);
  });
});

describe("the run report's caution (the user's first live run: 2 tasks, all passed)", () => {
  it("says when every draw gave the same rate, and when there are fewer than 10 tasks", () => {
    const text = formatReport([run("a", true), run("a", true), run("b", true), run("b", true)]);
    expect(text).toContain("95% interval 100%–100%");
    expect(text).toContain("Every draw gave the same rate, so the interval shows no uncertainty");
    expect(text).toContain("Only 2 tasks: with fewer than 10 tasks the interval is a rough guide.");
  });
});
