import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HARD_TASKS } from "../src/evals/hardTasks.js";
import { formatReport, runCheck, runEvalTask, writeFiles } from "../src/evals/runner.js";
import { ALL_TASKS } from "../src/evals/suites.js";
import { EVAL_TASKS } from "../src/evals/tasks.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";

describe("eval tasks (N5)", () => {
  it("has 10 tasks with unique ids", () => {
    expect(EVAL_TASKS).toHaveLength(10);
    expect(new Set(EVAL_TASKS.map((t) => t.id)).size).toBe(10);
  });

  // Each task must fail as given, and pass with its solution. Otherwise the eval measures nothing.
  it("the hard suite has 6 tasks on a repo of about 110 files", () => {
    expect(HARD_TASKS).toHaveLength(6);
    for (const task of HARD_TASKS) expect(Object.keys(task.files).length).toBeGreaterThan(100);
    expect(new Set(ALL_TASKS.map((t) => t.id)).size).toBe(ALL_TASKS.length);
  });

  for (const task of ALL_TASKS) {
    it(`${task.id}: the check fails before the fix and passes with the solution`, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), `garuda-task-${task.id}-`)));
      try {
        await writeFiles(root, task.files);
        expect((await runCheck(root, task.check)).ok).toBe(false);
        await writeFiles(root, task.solution);
        const after = await runCheck(root, task.check);
        expect(after.output).toBeDefined();
        expect(after.ok, after.output).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe("eval runner (N5)", () => {
  const task = EVAL_TASKS.find((t) => t.id === "fix-add");
  if (task === undefined) throw new Error("fix-add is missing");

  it("passes a task that the agent solves, and reports steps, tokens and cost", async () => {
    const out = mkdtempSync(join(tmpdir(), "garuda-eval-out-"));
    try {
      const result = await runEvalTask(task, {
        modelId: "claude-sonnet-5",
        model: () =>
          new FakeModelClient([
            reply([toolUse("read_file", { path: "src/math.js" }, "r1")]),
            reply([
              toolUse(
                "edit_file",
                { path: "src/math.js", old_string: "a - b", new_string: "a + b" },
                "e1",
              ),
            ]),
            reply([toolUse("bash", { command: "node --test" }, "b1")]),
            reply([text("Fixed.")]),
          ]),
        outDir: out,
      });
      expect(result).toMatchObject({ id: "fix-add", passed: true, stopReason: "done", steps: 4 });
      expect(result.tokens).toBe(60);
      expect(result.costUsd).toBeGreaterThan(0);
      expect(result.sessionFile).toBe(join(out, "fix-add.jsonl"));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("fails a task when the agent edits a protected test file", async () => {
    const result = await runEvalTask(task, {
      modelId: "fake",
      model: () =>
        new FakeModelClient([
          reply([toolUse("read_file", { path: "test/math.test.js" }, "r1")]),
          reply([
            toolUse(
              "edit_file",
              { path: "test/math.test.js", old_string: "5)", new_string: "-1)" },
              "e1",
            ),
          ]),
          reply([text("The test passes now.")]),
        ]),
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/changed protected files: test\/math\.test\.js/);
    expect(result.costUsd).toBeUndefined();
  });

  it("fails a task when the check fails, and when the model errors", async () => {
    const lazy = await runEvalTask(task, {
      modelId: "fake",
      model: () => new FakeModelClient([reply([text("Looks fine to me.")])]),
    });
    expect(lazy.passed).toBe(false);
    expect(lazy.reason).toMatch(/The check failed/);

    const broken = await runEvalTask(task, {
      modelId: "fake",
      model: () => new FakeModelClient([]),
    });
    expect(broken).toMatchObject({ passed: false, stopReason: "error" });
    expect(broken.reason).toMatch(/The run failed/);
  });

  it("prints a table and a pass count against the 7/10 target", () => {
    const report = formatReport([
      {
        id: "a",
        title: "",
        passed: true,
        stopReason: "done",
        steps: 3,
        tokens: 1500,
        costUsd: 0.01,
        durationMs: 2000,
      },
      {
        id: "b",
        title: "",
        passed: false,
        stopReason: "max_steps",
        steps: 50,
        tokens: 9000,
        costUsd: 0.2,
        durationMs: 9000,
      },
    ]);
    expect(report).toContain("PASS  a");
    expect(report).toContain("FAIL  b");
    expect(report).toContain("1/2 passed · 53 steps · cost $0.2100");
    expect(report).not.toContain("Mean per task");
    const repeated = formatReport([
      {
        id: "a",
        title: "",
        passed: true,
        stopReason: "done",
        steps: 4,
        tokens: 2000,
        costUsd: 0.02,
        durationMs: 1,
      },
      {
        id: "a",
        title: "",
        passed: false,
        stopReason: "done",
        steps: 6,
        tokens: 4000,
        costUsd: 0.04,
        durationMs: 1,
      },
    ]);
    expect(repeated).toContain("Mean per task:");
    expect(repeated).toContain("1/2   a                     5.0 steps      3.0k tok  $ 0.0300");
  });
});
