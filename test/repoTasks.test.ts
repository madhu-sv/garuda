import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildRepoSuite,
  type CommitInfo,
  dependencyChange,
  loadRepoSuite,
  MAX_TASK_FILES,
  REPO_SUITE_FILE,
  type RepoSuite,
  repoEvalTasks,
  repoPrompt,
  saveRepoSuite,
  scopedTestCommand,
  skipReason,
} from "../src/evals/repoTasks.js";
import { runEvalTask } from "../src/evals/runner.js";
import { git } from "../src/jobs/git.js";
import { cleanArgs } from "../src/jobs/worktree.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { HostExecutor } from "../src/sandbox/host.js";

/** Benchmark your repo (0.12, W3): eval tasks from the project's own commits. */

const host = new HostExecutor();
const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-repo-tasks-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const commit = (files: CommitInfo["files"]): CommitInfo => ({
  sha: "a".repeat(40),
  subject: "s",
  body: "",
  files,
});
const f = (path: string, added = 1) => ({ path, added, removed: 0 });

describe("repo tasks: the parts (0.12)", () => {
  it("keeps a commit that changes code and tests, and says why it skips the others", () => {
    expect(skipReason(commit([f("src/a.ts"), f("test/a.test.ts")]))).toBeUndefined();
    expect(skipReason(commit([]))).toBe("no files");
    expect(
      skipReason(commit(Array.from({ length: MAX_TASK_FILES + 1 }, (_, i) => f(`src/${i}.ts`)))),
    ).toBe(`more than ${MAX_TASK_FILES} files`);
    expect(skipReason(commit([{ path: "logo.png" }, f("test/a.test.ts")]))).toBe("a binary file");
    expect(skipReason(commit([f("go.mod"), f("src/a.ts"), f("test/a.test.ts")]))).toBe(
      "dependencies changed",
    );
    expect(skipReason(commit([f("src/a.ts")]))).toBe("no test change");
    expect(skipReason(commit([f("test/a.test.ts")]))).toBe("only tests changed");
    // Docs do not count toward the limit; package.json goes to dependencyChange.
    const docs = Array.from({ length: MAX_TASK_FILES }, (_, i) => f(`docs/${i}.md`));
    expect(skipReason(commit([...docs, f("README.md"), f("src/a.ts"), f("test/a.test.ts")]))).toBe(
      undefined,
    );
    expect(skipReason(commit([f("README.md"), f("test/a.test.ts")]))).toBe("only tests changed");
    expect(skipReason(commit([f("package.json"), f("src/a.ts"), f("test/a.test.ts")]))).toBe(
      undefined,
    );
    expect(skipReason(commit([f("pnpm-lock.yaml"), f("src/a.ts"), f("test/a.test.ts")]))).toBe(
      "dependencies changed",
    );
  });

  it("finds a dependency change in a package.json diff, not a version or script change", () => {
    const diff = (lines: string) => `--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n${lines}`;
    expect(dependencyChange(diff('-  "version": "0.11.0",\n+  "version": "0.12.0-dev",'))).toBe(
      false,
    );
    expect(dependencyChange(diff('+    "check": "pnpm test",'))).toBe(false);
    expect(dependencyChange(diff('-    "zod": "^4.0.0",\n+    "zod": "^4.1.0",'))).toBe(true);
    expect(dependencyChange(diff('+  "devDependencies": {'))).toBe(true);
    expect(dependencyChange(diff('   "zod": "^4.0.0",'))).toBe(false);
  });

  it("runs only the task's test files when it knows the runner", () => {
    const files = ["test/a.test.ts", "test/my b.test.ts"];
    expect(scopedTestCommand("pnpm test", files)).toBe(
      "pnpm test test/a.test.ts 'test/my b.test.ts'",
    );
    expect(scopedTestCommand("npm test", ["t.js"])).toBe("npm test -- t.js");
    expect(scopedTestCommand("node --test", ["t.js"])).toBe("node --test t.js");
    expect(scopedTestCommand("python3 -m pytest -q", ["tests/test_x.py"])).toBe(
      "python3 -m pytest -q tests/test_x.py",
    );
    expect(scopedTestCommand("make test FILES={files}", ["a", "b"])).toBe("make test FILES=a b");
    expect(scopedTestCommand("mvn -B -q -o test", ["src/test/X.java"])).toBe("mvn -B -q -o test");
    expect(scopedTestCommand("pnpm test && pnpm lint", ["t.js"])).toBe("pnpm test && pnpm lint");
  });

  it("writes the task from the commit message and names the visible tests", () => {
    expect(repoPrompt({ subject: "Add mul", body: "" }, ["test/mul.test.js"])).toBe(
      "Add mul\n\nThe tests for this change are already in the project: test/mul.test.js. Make the change so that they pass. Do not change these test files.",
    );
    expect(repoPrompt({ subject: "Fix x ", body: "Because y.\n" }, ["a", "b"])).toMatch(
      /^Fix x\n\nBecause y\.\n\nThe tests for this change are already in the project: a, b\./,
    );
  });

  it("maps the suite to eval tasks: the worktree, the check, the protected tests", () => {
    const suite: RepoSuite = {
      version: 1,
      root: "/r",
      head: "h",
      createdAt: "t",
      testCommand: "npm test",
      tasks: [
        {
          id: "repo-abc1234",
          sha: "abc1234",
          base: "b",
          subject: "Add x",
          prompt: "p",
          tests: [
            { path: "test/x.test.js", content: "x" },
            { path: "test/old.test.js", content: null },
          ],
        },
      ],
    };
    expect(repoEvalTasks(suite)).toEqual([
      {
        id: "repo-abc1234",
        title: "Add x",
        prompt: "p",
        files: {},
        check: "npm test",
        protect: ["test/x.test.js"],
        solution: {},
        repo: { root: "/r", base: "b", tests: suite.tasks[0]?.tests },
      },
    ]);
  });
});

/** A temp project with a history: one good task and one commit for each skip reason. */
async function history(root: string): Promise<Record<string, string>> {
  mkdirSync(root, { recursive: true });
  const run = (args: string[]) =>
    git(host, root, ["-c", "user.name=Test", "-c", "user.email=t@example.com", ...args]);
  await run(["init", "--quiet", "--initial-branch=main"]);
  const shas: Record<string, string> = {};
  const save = async (name: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    await run(["add", "-A"]);
    await run(["commit", "--quiet", "-m", name]);
    shas[name] = (await run(["rev-parse", "HEAD"])).stdout.trim();
  };
  const addTest =
    'const { test } = require("node:test");\nconst assert = require("node:assert");\nconst m = require("../src/math.js");\n';
  await save("Initial", {
    "src/math.js": "exports.add = (a, b) => a + b;\n",
    "test/add.test.js": `${addTest}test("add", () => assert.strictEqual(m.add(2, 3), 5));\n`,
  });
  await save("Add mul", {
    "src/math.js": "exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n",
    "test/mul.test.js": `${addTest}test("mul", () => assert.strictEqual(m.mul(2, 3), 6));\n`,
  });
  await save("Docs", { "README.md": "math\n" });
  await save("More tests", {
    "test/add2.test.js": `${addTest}test("add 0", () => assert.strictEqual(m.add(0, 0), 0));\n`,
  });
  await save("Comment and a test that passes already", {
    "src/math.js": "// Math.\nexports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n",
    "test/add3.test.js": `${addTest}test("add neg", () => assert.strictEqual(m.add(-1, 1), 0));\n`,
  });
  await save("Add sub (broken)", {
    "src/math.js":
      "// Math.\nexports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\nexports.sub = (a, b) => a + b;\n",
    "test/sub.test.js": `${addTest}test("sub", () => assert.strictEqual(m.sub(3, 1), 2));\n`,
  });
  return shas;
}

describe("git clean keeps the linked folders (0.12 live test)", () => {
  it("removes other untracked files but not the node_modules symlink", async () => {
    const dir = join(base, "clean");
    const target = join(base, "clean-deps");
    mkdirSync(target, { recursive: true });
    mkdirSync(dir, { recursive: true });
    const run = (args: string[]) =>
      git(host, dir, ["-c", "user.name=Test", "-c", "user.email=t@example.com", ...args]);
    await run(["init", "--quiet"]);
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    await run(["add", "-A"]);
    await run(["commit", "--quiet", "-m", "i"]);
    symlinkSync(target, join(dir, "node_modules"), "dir");
    writeFileSync(join(dir, "junk.txt"), "x");
    expect(cleanArgs(["node_modules"])).toEqual(["clean", "-fdq", "-e", "/node_modules"]);
    await git(host, dir, cleanArgs());
    expect(existsSync(join(dir, "junk.txt"))).toBe(false);
    expect(lstatSync(join(dir, "node_modules")).isSymbolicLink()).toBe(true);
  });
});

describe("repo tasks: the suite from git (0.12)", () => {
  const root = join(base, "project");
  let shas: Record<string, string> = {};
  let suite: RepoSuite;
  let skipped: Record<string, number> = {};
  let checked = 0;
  let failure: Awaited<ReturnType<typeof buildRepoSuite>>["failure"];
  const progress: string[] = [];

  beforeAll(async () => {
    shas = await history(root);
    ({ suite, skipped, checked, failure } = await buildRepoSuite(host, root, {
      testCommand: "node --test",
      onProgress: (line) => progress.push(line),
    }));
  }, 60_000);

  it("keeps the commit whose tests fail at the parent and pass at the commit", () => {
    expect(suite.tasks.map((t) => t.subject)).toEqual(["Add mul"]);
    const [task] = suite.tasks;
    expect(task).toMatchObject({
      id: `repo-${shas["Add mul"]?.slice(0, 7)}`,
      sha: shas["Add mul"],
      base: shas.Initial,
      tests: [{ path: "test/mul.test.js" }],
    });
    expect(task?.tests[0]?.content).toContain("m.mul(2, 3)");
    expect(suite).toMatchObject({ version: 1, root, head: shas["Add sub (broken)"] });
    expect(checked).toBe(3);
    expect(skipped).toEqual({
      "no test change": 1,
      "only tests changed": 1,
      "the first commit (no parent)": 1,
      "the tests already pass at the parent": 1,
      "the tests fail at the commit": 1,
    });
    // The check runs only the task's test file; the first failure at a commit is kept.
    expect(suite.tasks[0]?.check).toBe("node --test test/mul.test.js");
    expect(failure).toMatchObject({
      sha: shas["Add sub (broken)"],
      command: "node --test test/sub.test.js",
    });
    // The end of the output differs by Node version: the summary (Linux) or the assertion (macOS).
    expect(failure?.tail).toMatch(/# fail 1|4 !== 2/);
    expect(progress.at(-1)).toMatch(/^kept [0-9a-f]{7} \(1\/30\)$/);
  });

  it("leaves no worktree and does not change the checkout", async () => {
    const list = await git(host, root, ["worktree", "list", "--porcelain"]);
    expect(list.stdout.match(/^worktree /gm)).toHaveLength(1);
    const status = await git(host, root, ["status", "--porcelain"]);
    expect(status.stdout).toBe("");
  });

  it("saves and loads the suite", async () => {
    const file = await saveRepoSuite(suite);
    expect(file).toBe(join(root, REPO_SUITE_FILE));
    expect(await loadRepoSuite(root)).toEqual(suite);
    expect(await loadRepoSuite(join(base, "none"))).toBeUndefined();
    writeFileSync(file, '{"version":2}');
    await expect(loadRepoSuite(root)).rejects.toThrow(REPO_SUITE_FILE);
    await saveRepoSuite(suite);
  });

  it("runs a repo task in a worktree at the parent, and passes when the agent makes the change", async () => {
    const [task] = repoEvalTasks(suite);
    if (task === undefined) throw new Error("no task");
    const result = await runEvalTask(task, {
      modelId: "fake",
      model: () =>
        new FakeModelClient([
          reply([toolUse("read_file", { path: "src/math.js" }, "r1")]),
          reply([
            toolUse(
              "edit_file",
              {
                path: "src/math.js",
                old_string: "exports.add = (a, b) => a + b;",
                new_string: "exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;",
              },
              "e1",
            ),
          ]),
          reply([text("Added mul.")]),
        ]),
    });
    expect(result).toMatchObject({ id: task.id, passed: true, stopReason: "done" });
    const list = await git(host, root, ["worktree", "list", "--porcelain"]);
    expect(list.stdout.match(/^worktree /gm)).toHaveLength(1);
  }, 60_000);

  it("fails a repo task when the agent changes the task's tests", async () => {
    const [task] = repoEvalTasks(suite);
    if (task === undefined) throw new Error("no task");
    const result = await runEvalTask(task, {
      modelId: "fake",
      keep: true,
      model: () =>
        new FakeModelClient([
          reply([toolUse("read_file", { path: "test/mul.test.js" }, "r1")]),
          reply([
            toolUse(
              "edit_file",
              { path: "test/mul.test.js", old_string: "m.mul(2, 3), 6", new_string: "6, 6" },
              "e1",
            ),
          ]),
          reply([text("Done.")]),
        ]),
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/changed protected files: test\/mul\.test\.js/);
    // --keep leaves the worktree: the user can look at it, and git still knows it.
    const list = await git(host, root, ["worktree", "list", "--porcelain"]);
    const kept = /^worktree (.+garuda-repo-task-.+)$/m.exec(list.stdout)?.[1];
    expect(kept !== undefined && existsSync(join(kept, "test", "mul.test.js"))).toBe(true);
    await git(host, root, ["worktree", "remove", "--force", kept as string]);
  }, 60_000);
});
