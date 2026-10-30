import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { changedPaths, treeState, unexpectedPaths } from "../src/evals/changes.js";
import { REPORT_SCHEMA, reportV2, taskHash } from "../src/evals/report.js";
import { formatReport, isAuthFailure, runEvals, runEvalTask } from "../src/evals/runner.js";
import {
  consistency,
  costPerPass,
  passInterval,
  quantile,
  seeded,
  shuffled,
  spread,
  stepsSd,
  unexpectedChanges,
} from "../src/evals/stats.js";
import type { EvalResult, EvalTask } from "../src/evals/types.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";

/** T11a (0.17): the evidence of an eval run (docs/lld/eval-evidence.md). */

const run = (id: string, passed: boolean, over: Partial<EvalResult> = {}): EvalResult => ({
  id,
  title: id,
  passed,
  stopReason: "done",
  steps: 5,
  tokens: 1000,
  costUsd: 0.01,
  durationMs: 1000,
  ...over,
});

describe("stats", () => {
  it("the seeded generator and the shuffle repeat for one seed and differ for another", () => {
    const a = seeded(1);
    const b = seeded(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(shuffled(items, 7)).toEqual(shuffled(items, 7));
    expect(shuffled(items, 7)).not.toEqual(shuffled(items, 8));
    expect([...shuffled(items, 7)].sort((x, y) => x - y)).toEqual(items);
    expect(shuffled(items, 7)).not.toEqual(items);
  });

  it("the interval is a cluster bootstrap over tasks: repeats of one task move together", () => {
    // Task a passes 3 of 3, task b 0 of 3. A draw takes whole tasks, so its rate is 0, 0.5 or 1:
    // the interval is 0..1. A bootstrap over the 6 runs as if independent would be much narrower.
    const results = [...Array(3)].flatMap(() => [run("a", true), run("b", false)]);
    const i = passInterval(results, { seed: 1, draws: 2000 });
    expect(i).toMatchObject({ rate: 0.5, low: 0, high: 1, tasks: 2, seed: 1, level: 0.95 });
  });

  it("the same results and seed give the same interval; all passes give 100%..100%", () => {
    const results = ["a", "b", "c", "d", "e"].flatMap((id, n) =>
      [0, 1, 2].map((k) => run(id, (n + k) % 3 !== 0)),
    );
    const one = passInterval(results, { seed: 3 });
    expect(passInterval(results, { seed: 3 })).toEqual(one);
    expect(one?.low).toBeLessThanOrEqual(one?.rate ?? -1);
    expect(one?.high).toBeGreaterThanOrEqual(one?.rate ?? 2);
    expect(passInterval([run("a", true), run("b", true)])).toMatchObject({ low: 1, high: 1 });
    expect(passInterval([])).toBeUndefined();
    // An error run counts as a failure over all attempts.
    expect(passInterval([run("a", true), run("a", false, { stopReason: "error" })])?.rate).toBe(
      0.5,
    );
  });

  it("consistency, spread, steps deviation and quantiles", () => {
    const results = [
      run("a", true, { steps: 2 }),
      run("a", true, { steps: 4 }),
      run("b", false, { steps: 10 }),
      run("b", false, { steps: 20, stopReason: "error" }),
      run("c", true),
    ];
    expect(consistency(results)).toEqual({
      repeated: 2,
      allPassed: ["a"],
      nonePassed: ["b"],
      onlyErrors: [],
    });
    // A task whose runs all failed with an error never ran: it is not "passed none".
    const err = { stopReason: "error" };
    expect(consistency([run("x", false, err), run("x", false, err)])).toMatchObject({
      nonePassed: [],
      onlyErrors: ["x"],
    });
    // Error runs are left out of the spread.
    expect(spread(results)?.runs).toBe(4);
    expect(spread(results)?.steps.median).toBe(4.5);
    expect(stepsSd([run("a", true, { steps: 2 }), run("a", true, { steps: 4 })])).toBeCloseTo(
      Math.SQRT2,
    );
    expect(stepsSd([run("a", true)])).toBeUndefined();
    expect(quantile(Float64Array.from([1, 2, 3, 4]), 0.5)).toBe(2.5);
  });

  it("cost per accepted change counts every attempt, and keeps unknown and minimum costs", () => {
    expect(costPerPass([run("a", true), run("a", false), run("b", true)])).toMatchObject({
      kind: "value",
      usd: 0.015,
      totalUsd: 0.03,
      passes: 2,
      minimum: false,
    });
    expect(costPerPass([run("a", false)])).toMatchObject({ kind: "none" });
    expect(costPerPass([run("a", true), run("a", true, { costUsd: undefined })])).toEqual({
      kind: "unknown",
    });
    expect(costPerPass([run("a", true, { costIncomplete: true })])).toMatchObject({
      kind: "value",
      minimum: true,
    });
  });

  it("counts runs and files with unexpected changes; runs without the measure are left out", () => {
    expect(
      unexpectedChanges([
        run("a", true, { unexpected: ["x", "y"] }),
        run("a", true, { unexpected: [] }),
        run("b", true),
      ]),
    ).toEqual({ runs: 1, files: 2, measured: 2 });
  });
});

const temp = realpathSync(mkdtempSync(join(tmpdir(), "garuda-evidence-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("changed and unexpected files", () => {
  it("finds added, changed and deleted files, and leaves out git, Garuda and build output", async () => {
    const root = mkdtempSync(join(temp, "tree-"));
    const put = (path: string, content: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    put("src/a.js", "1");
    put("src/b.js", "2");
    put("README.md", "r");
    const before = await treeState(root);
    put("src/a.js", "changed");
    rmSync(join(root, "src/b.js"));
    put("src/c.js", "new");
    put("node_modules/x/index.js", "x");
    put(".garuda/sessions/s.jsonl", "{}");
    put(".git/HEAD", "ref");
    put("dist/out.js", "o");
    put("pkg/__pycache__/m.pyc", "c");
    put("Main.class", "c");
    expect(changedPaths(before, await treeState(root))).toEqual([
      "src/a.js",
      "src/b.js",
      "src/c.js",
    ]);
  });

  it("a change outside the solution files and the allowed globs is unexpected", () => {
    const changed = ["src/a.js", "src/util/x.js", "README.md"];
    expect(unexpectedPaths(changed, ["src/a.js"])).toEqual(["src/util/x.js", "README.md"]);
    expect(unexpectedPaths(changed, ["src/a.js"], ["src/**"])).toEqual(["README.md"]);
    expect(unexpectedPaths(changed, ["src/a.js"], ["*.md", "src/**"])).toEqual([]);
  });
});

describe("the runner records the changes and the attempt", () => {
  const task: EvalTask = {
    id: "scope",
    title: "scope",
    prompt: "Write the answer.",
    files: { "answer.txt": "?\n", "notes.md": "n\n" },
    check: "grep -q 42 answer.txt",
    solution: { "answer.txt": "42\n" },
  };
  const writes = () =>
    new FakeModelClient([
      reply([toolUse("read_file", { path: "answer.txt" }, "r1")]),
      reply([
        toolUse("edit_file", { path: "answer.txt", old_string: "?", new_string: "42" }, "e1"),
      ]),
      reply([toolUse("write_file", { path: "extra.txt", content: "x\n" }, "w2")]),
      reply([text("Done.")]),
    ]);

  it("a pass with an extra file: the pass stays, the extra file is unexpected", async () => {
    const r = await runEvalTask(task, { modelId: "fake", model: writes });
    expect(r.reason).toBeUndefined();
    expect(r.passed).toBe(true);
    expect(r.changed).toEqual(["answer.txt", "extra.txt"]);
    expect(r.unexpected).toEqual(["extra.txt"]);
    // allowChanges covers it.
    const allowed = await runEvalTask(
      { ...task, allowChanges: ["*.txt"] },
      {
        modelId: "fake",
        model: writes,
      },
    );
    expect(allowed.unexpected).toEqual([]);
  });

  it("runEvals numbers the repeats of each task in run order", async () => {
    const quick: EvalTask = { ...task, id: "q", check: "true" };
    const other: EvalTask = { ...quick, id: "o" };
    const results = await runEvals([quick, other, quick], {
      modelId: "fake",
      model: () => new FakeModelClient([reply([text("ok")])]),
    });
    expect(results.map((r) => [r.id, r.attempt])).toEqual([
      ["q", 1],
      ["o", 1],
      ["q", 2],
    ]);
  });
});

// The user's run (2026-10-29): a refused key made every run an error.
const refused = (id: string, attempt: number): EvalResult =>
  run(id, false, {
    attempt,
    stopReason: "error",
    steps: 0,
    reason:
      'The run failed: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  });

describe("runs that never ran", () => {
  it("a report with only error runs gives no interval and says why", () => {
    const report = formatReport([
      refused("a", 1),
      refused("a", 2),
      refused("b", 1),
      refused("b", 2),
    ]);
    expect(report).toContain("No scored run: every run failed with an error");
    expect(report).not.toContain("Pass rate over all attempts");
    expect(report).not.toContain("passed none");
    // One error run among real runs: the evidence stays, and the task is listed apart.
    const mixed = formatReport([
      run("a", true, { attempt: 1 }),
      run("a", true, { attempt: 2 }),
      refused("b", 1),
      refused("b", 2),
    ]);
    expect(mixed).toContain("Pass rate over all attempts: 50%");
    expect(mixed).toContain("0 passed none; 1 had only error runs (b)");
  });

  it("an authentication error stops the eval; other errors do not", async () => {
    expect(isAuthFailure(refused("a", 1))).toBe(true);
    expect(
      isAuthFailure(run("a", false, { stopReason: "error", reason: "403 permission_error" })),
    ).toBe(true);
    expect(
      isAuthFailure(
        run("a", false, { stopReason: "error", reason: "The run failed: socket hang up" }),
      ),
    ).toBe(false);
    // A failed check is no error run, even if its output says 401.
    expect(isAuthFailure(run("a", false, { reason: "The check failed:\nexpected 401" }))).toBe(
      false,
    );

    const task: EvalTask = {
      id: "k",
      title: "k",
      prompt: "p",
      files: { "a.txt": "a" },
      check: "true",
      solution: {},
    };
    const results = await runEvals(
      [task, { ...task, id: "l" }, { ...task, id: "m" }],
      {
        modelId: "fake",
        model: () => {
          throw new Error('401 {"type":"error","error":{"type":"authentication_error"}}');
        },
      },
      undefined,
      isAuthFailure,
    );
    expect(results.map((r) => r.id)).toEqual(["k"]);
    expect(results[0]?.reason).toMatch(/authentication_error/);
  });
});

describe("the report", () => {
  it("prints the interval, consistency, spread, cost per accepted change and unexpected changes", () => {
    const results = [
      run("a", true, { attempt: 1, unexpected: [] }),
      run("a", true, { attempt: 2, unexpected: ["README.md"] }),
      run("b", false, { attempt: 1, unexpected: [] }),
      run("b", false, { attempt: 2, unexpected: [] }),
    ];
    const report = formatReport(results, { seed: 1 });
    expect(report).toMatch(
      /Pass rate over all attempts: 50% \(95% interval 0%–100%; cluster bootstrap over 2 tasks, 10000 draws, seed 1\)/,
    );
    expect(report).toContain(
      "Consistency: 1 of 2 repeated tasks passed every run; 1 passed none (b)",
    );
    expect(report).toContain("Spread (4 scored runs): steps median 5.0, p95 5.0");
    expect(report).toContain("Cost per accepted change: $0.0200 (all attempts $0.0400 / 2 passes)");
    expect(report).toContain("Unexpected changes: 1 of 4 runs, 1 file");
    expect(report).toContain("  a (run 2): README.md");
    expect(report).toContain("sd 0.0 steps");
    expect(formatReport([run("a", false)])).toContain("Cost per accepted change: no passes");
  });

  it("report.json version 2: metadata, the run order and a stable hash per task", async () => {
    const task: EvalTask = {
      id: "t",
      title: "t",
      prompt: "p",
      files: { b: "2", a: "1" },
      check: "true",
      solution: {},
    };
    expect(taskHash(task)).toBe(taskHash({ ...task, files: { a: "1", b: "2" } }));
    expect(taskHash(task)).not.toBe(taskHash({ ...task, prompt: "q" }));
    expect(taskHash(task)).not.toBe(taskHash({ ...task, allowChanges: ["src/**"] }));
    const results = [run("t", true, { attempt: 1 }), run("t", false, { attempt: 2 })];
    const v2 = await reportV2(
      {
        model: "fake",
        provider: "anthropic",
        executor: "host",
        isolation: "none",
        seed: 4,
        shuffle: true,
      },
      [task],
      results,
    );
    expect(v2).toMatchObject({
      schema: REPORT_SCHEMA,
      spec: "fake",
      provider: "anthropic",
      seed: 4,
      shuffle: true,
      order: [
        { id: "t", attempt: 1 },
        { id: "t", attempt: 2 },
      ],
      tasks: { t: taskHash(task) },
    });
    expect(REPORT_SCHEMA).toBe(2);
    expect((v2.garuda as { version: string }).version).toMatch(/^\d+\.\d+\.\d+/);
    expect((v2.evidence as { costPerAcceptedChange: unknown }).costPerAcceptedChange).toMatchObject(
      {
        kind: "value",
        passes: 1,
      },
    );
  });
});
