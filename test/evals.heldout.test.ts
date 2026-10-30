import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELD_OUT_TASKS } from "../src/evals/heldOutTasks.js";
import { taskHash } from "../src/evals/report.js";
import { formatReport, runCheck } from "../src/evals/runner.js";
import { ALL_TASKS, chooseTasks, EVAL_SUITES } from "../src/evals/suites.js";
import type { EvalTask } from "../src/evals/types.js";
import { checkWith, expectFailsThenPasses, solutionWith, toolchainReadiness } from "./evalTasks.js";

/** The held-out set (0.17, T11c; docs/lld/eval-evidence.md). */

/**
 * The version hash of each held-out task, recorded when it was added. A change to a task changes
 * its hash: update this table on purpose, say so in the CHANGELOG, and treat every tuning result
 * seen before the change as invalid.
 */
const HELD_OUT_HASHES: Record<string, string> = {
  "held-out-command-registry": "a594f1385f0e36bfd09f2599af26094f0387d20720e470be0d0a3e464a6caf5f",
  "held-out-conventions-migration":
    "c11f910481c90c63b7f15a22c63825a31ca38101ef86d30430265bdb02ea49d8",
  "held-out-conventions-reset": "edb029113a55761738605c8c116e2748e9632d074ed36e553bbd9467719bc66b",
  "held-out-invoice-split": "d09f246ef788f2d199a51fd89cfa8a97a14a33d1868fb9a369e0c9e604c673c6",
  "held-out-payment-retry": "a5d5ae43df9c118e49e02caae81dfaa1fb91545a63eeff0eb9bbabdbb3a4f18d",
  "held-out-price-cache": "61abb0b9c002dff49ce6fb3d426b2b8db63899a230a97c82b1e4d4cc4a0e0579",
  "held-out-settings": "09c1ec61bfc8ce718aed374dc86632faa416787b11243eb85349d049a779eae7",
  "held-out-slow-search": "ee0cec3a0b6bd2931ea63c36467d8299148417d8324cfba6200ec3e76a79eb9d",
  "held-out-tests-csv-field": "ff5ad58b58d1024a8632e8cc3b39c6ca718d4f978b353c3f8174adf580dc8029",
  "held-out-tests-intervals": "a8d2581e8ada8b001f79e62209ea127c7d7059c86c9995bfcc839e701b91c1b8",
};

const { status, ready, skipNote } = await toolchainReadiness();

const task = (id: string) => {
  const found = HELD_OUT_TASKS.find((t) => t.id === id);
  if (found === undefined) throw new Error(`no task ${id}`);
  return found;
};

describe("the held-out set", () => {
  it("has 10 tasks, all split heldout, with ids apart from the dev tasks", () => {
    expect(HELD_OUT_TASKS).toHaveLength(10);
    const ids = HELD_OUT_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(10);
    for (const t of HELD_OUT_TASKS) expect(t.split).toBe("heldout");
    const dev = new Set(ALL_TASKS.map((t) => t.id));
    expect(ids.filter((id) => dev.has(id))).toEqual([]);
    // No dev suite holds a held-out task, so a plain `garuda eval -s all` cannot run one.
    expect(ALL_TASKS.filter((t) => t.split === "heldout")).toEqual([]);
  });

  it("is in TypeScript, Python and Java", () => {
    const lang = (t: EvalTask) =>
      t.requires?.includes("maven") ? "java" : t.requires?.includes("pytest") ? "python" : "ts";
    const count = (l: string) => HELD_OUT_TASKS.filter((t) => lang(t) === l).length;
    expect([count("ts"), count("python"), count("java")]).toEqual([5, 4, 1]);
  });

  it("protects the build files, the fixtures and the code under test", () => {
    const protectedOf = (t: EvalTask) =>
      t.protect ??
      Object.keys(t.files).filter((p) =>
        /^(test|tests|src\/test)\/|^pom\.xml$|^pyproject\.toml$/.test(p),
      );
    for (const t of HELD_OUT_TASKS) {
      for (const build of ["pom.xml", "pyproject.toml"]) {
        if (build in t.files) expect(protectedOf(t), `${t.id}: ${build}`).toContain(build);
      }
    }
    expect(protectedOf(task("held-out-payment-retry"))).toContain("tests/fake_service.py");
    expect(protectedOf(task("held-out-slow-search"))).toContain("src/db.ts");
    expect(protectedOf(task("held-out-conventions-reset"))).toContain("src/app/services.py");
    expect(protectedOf(task("held-out-conventions-migration"))).toContain(
      "migrations/0001_create_todos.ts",
    );
    expect(protectedOf(task("held-out-tests-intervals"))).toContain("src/intervals.ts");
    expect(protectedOf(task("held-out-tests-csv-field"))).toContain("src/sheets/csvfield.py");
  });

  it("each task's hash is the recorded one", () => {
    const now = Object.fromEntries(HELD_OUT_TASKS.map((t) => [t.id, taskHash(t)]));
    expect(now).toEqual(HELD_OUT_HASHES);
  });
});

describe.concurrent("each held-out task fails before the fix and passes with the solution", () => {
  for (const t of HELD_OUT_TASKS) {
    it.skipIf(!ready(t))(`${t.id}${skipNote(t)}`, () => expectFailsThenPasses(t), 180_000);
  }
});

/** Each task's trap: a quick fix that passes the visible tests must fail the check. */
describe.concurrent("the checks refuse the quick fixes", () => {
  it("held-out-price-cache: clearing the cache when one session changes currency", async () => {
    const t = task("held-out-price-cache");
    const quick = {
      "src/session.ts": (t.files["src/session.ts"] ?? "").replace(
        "    this.currency = currency;",
        "    this.currency = currency;\n    (this.prices as unknown as { clear(): void }).clear();",
      ),
      "src/prices.ts": (t.files["src/prices.ts"] ?? "").replace(
        "  /** The price of product",
        "  clear(): void {\n    this.cache.deleteWhere(() => true);\n  }\n\n  /** The price of product",
      ),
    };
    expect((await checkWith(t, { ...t.files, ...quick })).ok).toBe(false);
  });

  it("held-out-price-cache: the currency in the key, but a price change still deletes by id", async () => {
    const t = task("held-out-price-cache");
    const quick = solutionWith(t, "src/prices.ts", [
      [
        'catalog.onChange((id) => this.cache.deleteWhere((key) => key.startsWith(id + "|")));',
        "catalog.onChange((id) => this.cache.delete(id));",
      ],
    ]);
    expect((await checkWith(t, quick)).ok).toBe(false);
  });

  it.skipIf(status.get("pytest") !== true)(
    "held-out-payment-retry: a key made from the account and the amount",
    async () => {
      const t = task("held-out-payment-retry");
      const quick = solutionWith(t, "src/shop/payments.py", [
        ["        key = str(uuid.uuid4())", '        key = account + ":" + str(amount_minor)'],
      ]);
      expect((await checkWith(t, quick)).ok).toBe(false);
    },
    60_000,
  );

  it("held-out-command-registry: a registry for dispatch only, the help and completion as before", async () => {
    const t = task("held-out-command-registry");
    const quick = {
      ...t.solution,
      "src/help.ts": t.files["src/help.ts"] ?? "",
      "src/complete.ts": t.files["src/complete.ts"] ?? "",
    };
    expect((await checkWith(t, quick)).ok).toBe(false);
  });

  it.skipIf(status.get("pytest") !== true)(
    "held-out-settings: the old switch rules in place of the README's",
    async () => {
      const t = task("held-out-settings");
      const quick = solutionWith(t, "src/app/settings.py", [
        [
          "def _switch(env: Mapping[str, str], name: str) -> bool:\n",
          'def _switch(env: Mapping[str, str], name: str) -> bool:\n    return env.get(name, "") in ("1", "true")\n',
        ],
      ]);
      expect((await checkWith(t, quick)).ok).toBe(false);
    },
    60_000,
  );

  it.skipIf(status.get("pytest") !== true)(
    "held-out-settings: a module that still reads the environment",
    async () => {
      const t = task("held-out-settings");
      const quick = solutionWith(t, "src/app/features.py", [
        ["    return settings.debug", '    return settings.debug or os.environ.get("X") == "1"'],
        ["from .settings import Settings", "import os\n\nfrom .settings import Settings"],
      ]);
      expect((await checkWith(t, quick)).ok).toBe(false);
    },
    60_000,
  );

  it("held-out-tests-intervals: tests of the plain cases only", async () => {
    const t = task("held-out-tests-intervals");
    const full = t.solution["test/intervals.test.ts"] ?? "";
    const plain = full.slice(0, full.indexOf('test("an interval inside another'));
    expect((await checkWith(t, { "test/intervals.test.ts": plain })).ok).toBe(false);
  });

  it.skipIf(status.get("pytest") !== true)(
    "held-out-tests-csv-field: tests without @, CR and a leading space",
    async () => {
      const t = task("held-out-tests-csv-field");
      const weak = solutionWith(t, "tests/test_csvfield.py", [
        ['        ("cr\\rhere", \'"cr\\rhere"\'),\n', ""],
        ['        (" lead", \'" lead"\'),\n', ""],
        ['        ("@cmd", "\'@cmd"),\n', ""],
      ]);
      expect((await checkWith(t, weak)).ok).toBe(false);
    },
    60_000,
  );

  it("held-out-conventions-migration: a camelCase column", async () => {
    const t = task("held-out-conventions-migration");
    const quick = {
      ...t.solution,
      "migrations/0003_add_due_date.ts": (
        t.solution["migrations/0003_add_due_date.ts"] ?? ""
      ).replaceAll('"due_date"', '"dueDate"'),
      "src/todos/repo.ts": (t.solution["src/todos/repo.ts"] ?? "").replaceAll(
        "due_date",
        "dueDate",
      ),
    };
    expect((await checkWith(t, quick)).ok).toBe(false);
  });

  it("held-out-conventions-migration: no dueDate field when there is no date", async () => {
    const t = task("held-out-conventions-migration");
    const quick = solutionWith(t, "src/todos/repo.ts", [
      [
        "    dueDate: row.due_date instanceof Date ? row.due_date.toISOString() : null,",
        "    ...(row.due_date instanceof Date ? { dueDate: row.due_date.toISOString() } : {}),",
      ],
    ]);
    expect((await checkWith(t, quick)).ok).toBe(false);
  });

  for (const [name, edit] of [
    ["the token in the log", ["redact(token)", "token"]],
    ["no rate limit", ["    services.limiter.hit(email.lower())\n", ""]],
    [
      "a 404 for an unknown address",
      [
        '        log.info("password reset for an unknown address")\n        return',
        '        from ..errors import NotFound\n\n        raise NotFound("no account")',
      ],
    ],
  ] as const) {
    it.skipIf(status.get("pytest") !== true)(
      `held-out-conventions-reset: ${name}`,
      async () => {
        const t = task("held-out-conventions-reset");
        const quick = solutionWith(t, "src/app/domain/password_reset.py", [[edit[0], edit[1]]]);
        expect((await checkWith(t, quick)).ok).toBe(false);
      },
      60_000,
    );
  }

  it("held-out-slow-search: one query for the tags, but in the order that query gives", async () => {
    const t = task("held-out-slow-search");
    const quick = solutionWith(t, "src/search.ts", [
      [
        '    tags: item.tagIds.map((id) => labels.get(id) ?? ""),',
        '    tags: [...new Set(item.tagIds)].sort((a, b) => a - b).map((id) => labels.get(id) ?? ""),',
      ],
    ]);
    expect((await checkWith(t, quick)).ok).toBe(false);
  });
});

describe("a failed check says why (the second held-out run, 2026-10-30)", () => {
  it("a guard names what is missing", async () => {
    const t = task("held-out-conventions-migration");
    const { "test/dueDate.test.ts": _test, ...noTest } = t.solution;
    const r = await checkWith(t, noTest);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("check: no test in test/ mentions the due date");
  });

  it("a check with no output gives its exit code", async () => {
    const root = mkdtempSync(join(tmpdir(), "garuda-check-"));
    try {
      expect(await runCheck(root, "exit 3")).toEqual({
        ok: false,
        output: "(no output; exit code 3)",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the prompt names the field that the hidden test reads", () => {
    expect(task("held-out-conventions-migration").prompt).toContain("`dueDate`");
  });
});

describe("the report fits the long held-out ids", () => {
  it("the columns after the id line up for a 30-character id", () => {
    const run = (id: string) => ({
      id,
      title: id,
      passed: true,
      stopReason: "done",
      steps: 5,
      tokens: 1000,
      costUsd: 0.01,
      durationMs: 1000,
    });
    const long = "held-out-conventions-migration";
    // Two runs a task, so the report has its mean rows too.
    const text = formatReport([run(long), run(long), run("fix-add"), run("fix-add")]);
    const at = (line: string | undefined) => line?.indexOf(" steps") ?? -1;
    const runRows = text.split("\n").filter((l) => l.startsWith("PASS"));
    expect(runRows).toHaveLength(4);
    expect(at(runRows[0])).toBe(at(runRows[2]));
    const meanRows = text.split("\n").filter((l) => l.startsWith("2/2"));
    expect(meanRows).toHaveLength(2);
    expect(at(meanRows[0])).toBe(at(meanRows[1]));
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
    expect(ids({ suite: "medium" })).toEqual(EVAL_SUITES.medium?.map((t) => t.id));
  });

  it("heldout takes the held-out set, and -t picks within it", () => {
    expect(ids({ split: "heldout" })).toEqual(heldOutIds);
    expect(ids({ split: "heldout", task: ["held-out-price-cache", "fix-add"] })).toEqual([
      "held-out-price-cache",
    ]);
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
    expect(problem({ task: ["held-out-price-cache"] })).toBe(
      "held-out-price-cache: held-out task(s). Add --split heldout to run them.",
    );
    expect(problem({ split: "test" })).toBe("Unknown split test. Use: dev, heldout, all.");
    expect(problem({ suite: "nope" })).toMatch(/^Unknown suite nope/);
  });
});
