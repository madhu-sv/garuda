import { describe, expect, it } from "vitest";
import { unexpectedPaths } from "../src/evals/changes.js";
import { MEDIUM_TASKS } from "../src/evals/mediumTasks.js";
import { isProtectedPath } from "../src/evals/projects.js";
import { EVAL_SUITES } from "../src/evals/suites.js";
import type { EvalTask } from "../src/evals/types.js";
import { checkWith, expectFailsThenPasses, toolchainReadiness } from "./evalTasks.js";

/** The medium suite (0.17, T11c): the first held-out set, now a dev suite. */

const { status, ready, skipNote } = await toolchainReadiness();

describe("the medium suite", () => {
  it("has 10 dev tasks with ids apart from the other suites", () => {
    expect(MEDIUM_TASKS).toHaveLength(10);
    const ids = MEDIUM_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(10);
    for (const task of MEDIUM_TASKS) expect(task.split).toBeUndefined();
    expect(EVAL_SUITES.medium).toBe(MEDIUM_TASKS);
    const others = Object.entries(EVAL_SUITES).filter(([name]) => name !== "medium");
    const otherIds = new Set(others.flatMap(([, tasks]) => tasks.map((t) => t.id)));
    expect(ids.filter((id) => otherIds.has(id))).toEqual([]);
  });

  it("covers the archetypes in TypeScript, Python and Java", () => {
    const langs = (t: EvalTask) =>
      t.requires?.includes("maven") ? "java" : t.requires?.includes("pytest") ? "python" : "ts";
    const count = (lang: string) => MEDIUM_TASKS.filter((t) => langs(t) === lang).length;
    expect([count("ts"), count("python"), count("java")]).toEqual([5, 3, 2]);
  });

  it("protects every test and build file, except where a hidden test decides", () => {
    // med-export-dates: its hidden test decides, so the agent may add a test (the first live run).
    for (const task of MEDIUM_TASKS.filter((t) => t.id !== "med-export-dates")) {
      const protectedFiles = task.protect ?? Object.keys(task.files).filter(isProtectedPath);
      for (const path of Object.keys(task.files).filter(isProtectedPath)) {
        expect(protectedFiles, `${task.id}: ${path}`).toContain(path);
      }
    }
  });
});

describe.concurrent("each medium task fails before the fix and passes with the solution", () => {
  for (const task of MEDIUM_TASKS) {
    it.skipIf(!ready(task))(
      `${task.id}${skipNote(task)}`,
      () => expectFailsThenPasses(task),
      180_000,
    );
  }
});

const task = (id: string) => {
  const found = MEDIUM_TASKS.find((t) => t.id === id);
  if (found === undefined) throw new Error(`no task ${id}`);
  return found;
};

describe.concurrent("the checks refuse weak answers", () => {
  it("med-tests-limiter: a test that passes on every mutant fails the mutation check", async () => {
    const weak = {
      "test/limiter.test.ts": [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { TokenBucket } from "../src/limiter.ts";',
        'test("it exists", () => { assert.ok(new TokenBucket(5, 1, () => 0)); });',
        "",
      ].join("\n"),
    };
    expect((await checkWith(task("med-tests-limiter"), weak)).ok).toBe(false);
  });

  it.skipIf(status.get("pytest") !== true)(
    "med-tests-duration: a test of seconds only misses the hour mutant",
    async () => {
      const weak = {
        "tests/test_parse.py": [
          "from durations.parse import parse_duration",
          "",
          "",
          "def test_seconds():",
          '    assert parse_duration("5s") == 5',
          "",
        ].join("\n"),
      };
      expect((await checkWith(task("med-tests-duration"), weak)).ok).toBe(false);
    },
    60_000,
  );

  it("med-rename-option: the new name with the old one still in the code fails", async () => {
    const t = task("med-rename-option");
    const left = Object.fromEntries(
      Object.entries(t.solution).map(([path, text]) => [
        path,
        path === "src/client.ts" ? `${text}\n// timeoutMs\n` : text,
      ]),
    );
    expect((await checkWith(t, left)).ok).toBe(false);
  });

  it("med-conventions-cli: a print() in the command fails, even with the right output", async () => {
    const t = task("med-conventions-cli");
    const path = "src/todo_cli/commands/stats.py";
    const solution = t.solution[path];
    expect(solution).toBeDefined();
    const printed = { ...t.solution, [path]: `${solution}\nprint("debug")\n` };
    expect((await checkWith(t, printed)).ok).toBe(false);
  });
});

describe("the checks accept a careful answer (the first live run, 2026-10-30)", () => {
  it("med-export-dates: the fix with a CSV test added to the visible tests passes", async () => {
    const t = task("med-export-dates");
    const visible = t.files["test/export.test.ts"] ?? "";
    const added = {
      ...t.solution,
      "test/export.test.ts": visible
        .replace(
          'import { toJson } from "../src/export/json.ts";',
          'import { toCsv } from "../src/export/csv.ts";\nimport { toJson } from "../src/export/json.ts";',
        )
        .concat('test("csv", () => assert.match(toCsv(rows), /rent,950\\.00,2026-10-28/));\n'),
    };
    expect((await checkWith(t, added)).ok).toBe(true);
    // Not protected, and not an unexpected change.
    expect(t.protect).toEqual([]);
    expect(
      unexpectedPaths(
        ["src/export/csv.ts", "test/export.test.ts"],
        Object.keys(t.solution),
        t.allowChanges,
      ),
    ).toEqual([]);
  });

  it("a new test for the new code is in scope in the conventions tasks", () => {
    const scope = (id: string, path: string) => {
      const t = task(id);
      return unexpectedPaths([path], Object.keys(t.solution), t.allowChanges);
    };
    expect(scope("med-conventions-cli", "tests/test_stats.py")).toEqual([]);
    expect(scope("med-conventions-handler", "test/handlers/extra.test.ts")).toEqual([]);
    // Outside the scope it still counts.
    expect(scope("med-conventions-cli", "src/todo_cli/store.py")).toEqual([
      "src/todo_cli/store.py",
    ]);
  });
});
