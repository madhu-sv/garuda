import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unexpectedPaths } from "../src/evals/changes.js";
import { HELD_OUT_TASKS } from "../src/evals/heldOutTasks.js";
import { isProtectedPath } from "../src/evals/projects.js";
import { taskHash } from "../src/evals/report.js";
import { runCheck, writeFiles } from "../src/evals/runner.js";
import { ALL_TASKS, chooseTasks, EVAL_SUITES } from "../src/evals/suites.js";
import { checkToolchains, TOOLCHAINS, type ToolchainId } from "../src/evals/toolchains.js";
import type { EvalTask } from "../src/evals/types.js";
import { expectFailsThenPasses } from "./evalTasks.js";

/** The held-out set (0.17, T11c; docs/lld/eval-evidence.md). */

/**
 * The version hash of each held-out task, recorded when it was added. A change to a task changes
 * its hash: update this table on purpose, say so in the CHANGELOG, and treat every tuning result
 * seen before the change as invalid.
 */
const HELD_OUT_HASHES: Record<string, string> = {
  "ho-conventions-cli": "87bba8f5d9a84b50ec726a596b3128f734a00360df840d2239909c3fcf448faf",
  "ho-conventions-handler": "d8b9047d54923fd4a4b172c9c6f5ef0c620b6ccd81eaee97ff9c896687cd52f3",
  "ho-export-dates": "20756cab96b74c6084a022bfb99c7e568aff9d3e082ee0e005f950bd37586fa7",
  "ho-inventory": "61f82dab50057c9dccad097514590c0c60dd743d01611416cf33c9552bda6141",
  "ho-ledger": "f64c4a19923ba27e61fb7cc70627736cbe8172c396b07daa48b4241108489832",
  "ho-notifier": "c0731158ec862db593c0fc17dd496e7c19091685d416522c0e8cafef0d8c675f",
  "ho-rename-option": "e622e1f4b2b86f84f5ce6efe9b87a9210505e02770771aa994258401ed2538ee",
  "ho-scheduler": "0c4f18c50c88c5b489eedeeaf0cc2c237a9769780cc78374caccde1292c0fa19",
  "ho-tests-duration": "3f27ffd4ad2eb8630f47e52a8f005c9783db6ac773e9d9b68ccd585fe885d744",
  "ho-tests-limiter": "26d1c83fd29f6fda42442ddc12c679c28e9c3d25edac737716bb6d0c7f9d2d18",
};

const status = new Map(
  (await checkToolchains(["pytest", "maven"])).map((s) => [s.id, s.ok === true] as const),
);
const ready = (task: EvalTask) => (task.requires ?? []).every((id) => status.get(id) === true);
const skipNote = (task: EvalTask) => {
  const missing = (task.requires ?? []).filter((id) => status.get(id) !== true);
  return missing.length === 0
    ? ""
    : ` (skipped: ${missing.map((id: ToolchainId) => TOOLCHAINS[id].hint).join("; ")})`;
};

describe("the held-out set", () => {
  it("has 10 tasks, all split heldout, with ids apart from the dev tasks", () => {
    expect(HELD_OUT_TASKS).toHaveLength(10);
    const ids = HELD_OUT_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(10);
    for (const task of HELD_OUT_TASKS) expect(task.split).toBe("heldout");
    const dev = new Set(ALL_TASKS.map((t) => t.id));
    expect(ids.filter((id) => dev.has(id))).toEqual([]);
    // No dev suite holds a held-out task, so a plain `garuda eval -s all` cannot run one.
    expect(ALL_TASKS.filter((t) => t.split === "heldout")).toEqual([]);
  });

  it("covers the archetypes in TypeScript, Python and Java", () => {
    const langs = (t: EvalTask) =>
      t.requires?.includes("maven") ? "java" : t.requires?.includes("pytest") ? "python" : "ts";
    const count = (lang: string) => HELD_OUT_TASKS.filter((t) => langs(t) === lang).length;
    expect([count("ts"), count("python"), count("java")]).toEqual([5, 3, 2]);
  });

  it("protects every test and build file, except where a hidden test decides", () => {
    // ho-export-dates: its hidden test decides, so the agent may add a test (the first live run).
    for (const task of HELD_OUT_TASKS.filter((t) => t.id !== "ho-export-dates")) {
      const protectedFiles = task.protect ?? Object.keys(task.files).filter(isProtectedPath);
      for (const path of Object.keys(task.files).filter(isProtectedPath)) {
        expect(protectedFiles, `${task.id}: ${path}`).toContain(path);
      }
    }
  });

  it("each task's hash is the recorded one", () => {
    const now = Object.fromEntries(HELD_OUT_TASKS.map((t) => [t.id, taskHash(t)]));
    expect(now).toEqual(HELD_OUT_HASHES);
  });
});

describe.concurrent("each held-out task fails before the fix and passes with the solution", () => {
  for (const task of HELD_OUT_TASKS) {
    it.skipIf(!ready(task))(
      `${task.id}${skipNote(task)}`,
      () => expectFailsThenPasses(task),
      180_000,
    );
  }
});

/** Run the check after the agent wrote `files` (on top of the task's own files). */
async function checkWith(task: EvalTask, files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `garuda-task-${task.id}-`)));
  try {
    await writeFiles(root, task.files);
    await writeFiles(root, files);
    return await runCheck(root, task.check);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const task = (id: string) => {
  const found = HELD_OUT_TASKS.find((t) => t.id === id);
  if (found === undefined) throw new Error(`no task ${id}`);
  return found;
};

describe.concurrent("the checks refuse weak answers", () => {
  it("ho-tests-limiter: a test that passes on every mutant fails the mutation check", async () => {
    const weak = {
      "test/limiter.test.ts": [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { TokenBucket } from "../src/limiter.ts";',
        'test("it exists", () => { assert.ok(new TokenBucket(5, 1, () => 0)); });',
        "",
      ].join("\n"),
    };
    expect((await checkWith(task("ho-tests-limiter"), weak)).ok).toBe(false);
  });

  it.skipIf(status.get("pytest") !== true)(
    "ho-tests-duration: a test of seconds only misses the hour mutant",
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
      expect((await checkWith(task("ho-tests-duration"), weak)).ok).toBe(false);
    },
    60_000,
  );

  it("ho-rename-option: the new name with the old one still in the code fails", async () => {
    const t = task("ho-rename-option");
    const left = Object.fromEntries(
      Object.entries(t.solution).map(([path, text]) => [
        path,
        path === "src/client.ts" ? `${text}\n// timeoutMs\n` : text,
      ]),
    );
    expect((await checkWith(t, left)).ok).toBe(false);
  });

  it("ho-conventions-cli: a print() in the command fails, even with the right output", async () => {
    const t = task("ho-conventions-cli");
    const path = "src/todo_cli/commands/stats.py";
    const solution = t.solution[path];
    expect(solution).toBeDefined();
    const printed = { ...t.solution, [path]: `${solution}\nprint("debug")\n` };
    expect((await checkWith(t, printed)).ok).toBe(false);
  });
});

describe("the checks accept a careful answer (the first live run, 2026-10-30)", () => {
  it("ho-export-dates: the fix with a CSV test added to the visible tests passes", async () => {
    const t = task("ho-export-dates");
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
    expect(scope("ho-conventions-cli", "tests/test_stats.py")).toEqual([]);
    expect(scope("ho-conventions-handler", "test/handlers/extra.test.ts")).toEqual([]);
    // Outside the scope it still counts.
    expect(scope("ho-conventions-cli", "src/todo_cli/store.py")).toEqual(["src/todo_cli/store.py"]);
  });
});

describe("--split chooses the tasks", () => {
  const ids = (choice: Parameters<typeof chooseTasks>[0]) => {
    const r = chooseTasks(choice);
    if ("problem" in r) throw new Error(r.problem);
    return r.tasks.map((t) => t.id);
  };
  const problem = (choice: Parameters<typeof chooseTasks>[0]) => {
    const r = chooseTasks(choice);
    return "problem" in r ? r.problem : undefined;
  };
  const heldOutIds = HELD_OUT_TASKS.map((t) => t.id);

  it("the default is the basic dev suite; -s all has no held-out task", () => {
    expect(ids({})).toEqual(EVAL_SUITES.basic?.map((t) => t.id));
    expect(ids({ suite: "all" }).filter((id) => heldOutIds.includes(id))).toEqual([]);
  });

  it("heldout takes the held-out set, and -t picks within it", () => {
    expect(ids({ split: "heldout" })).toEqual(heldOutIds);
    expect(ids({ split: "heldout", task: ["ho-ledger", "fix-add"] })).toEqual(["ho-ledger"]);
    expect(problem({ split: "heldout", suite: "basic" })).toMatch(/-s picks dev suites/);
  });

  it("all takes every dev task and the held-out set", () => {
    expect(ids({ split: "all" })).toEqual([...ALL_TASKS.map((t) => t.id), ...heldOutIds]);
    expect(ids({ split: "all", suite: "hard" })).toEqual([
      ...(EVAL_SUITES.hard ?? []).map((t) => t.id),
      ...heldOutIds,
    ]);
  });

  it("a held-out id on the dev split is refused with the fix, not run", () => {
    expect(problem({ task: ["ho-ledger"] })).toBe(
      "ho-ledger: held-out task(s). Add --split heldout to run them.",
    );
    expect(problem({ split: "test" })).toBe("Unknown split test. Use: dev, heldout, all.");
    expect(problem({ suite: "nope" })).toMatch(/^Unknown suite nope/);
  });
});
