import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { finishJob, prepareJob, testsBefore } from "../src/cli/jobCommand.js";
import { createJob } from "../src/jobs/create.js";
import { git } from "../src/jobs/git.js";
import { loadJob } from "../src/jobs/job.js";
import {
  detectTestCommand,
  jobVerdict,
  parseReview,
  REVIEW_DIFF_CHARS,
  reviewerSystem,
  reviewPrompt,
  riskFlags,
  stackOf,
  tail,
} from "../src/jobs/proof.js";
import { jobPrompt } from "../src/jobs/text.js";
import type { LanguageProfile } from "../src/lang/profiles.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { JOB_DENIAL } from "../src/permissions/engine.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { FileSessionStore } from "../src/session/store.js";

/** Proof of work for jobs (0.11, W2). */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-proof-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const host = new HostExecutor();
class SandboxedHost extends HostExecutor {
  override readonly isolation = "os" as unknown as "none";
}
const quiet = { event: () => {}, info: () => {}, warn: () => {}, error: () => {} };
function write(top: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(top, path)), { recursive: true });
    writeFileSync(join(top, path), content);
  }
}

const done = { stopReason: "done", files: [], denied: [] };
const pass = { exitCode: 0, timedOut: false, durationMs: 1000, tail: "ok" };
const fail = { exitCode: 1, timedOut: false, durationMs: 2000, tail: "1 failing" };

describe("proof of work: the parts (0.11)", () => {
  it("finds the test command: a package.json script by the lock file, else the profile", () => {
    const dir = join(base, `d${n++}`);
    write(dir, { "package.json": '{"scripts":{"test":"vitest run"}}', "pnpm-lock.yaml": "" });
    expect(detectTestCommand(dir, [])).toBe("pnpm test");
    const npm = join(base, `d${n++}`);
    write(npm, {
      "package.json": '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}',
    });
    const python = { test: "python -m pytest -q" } as LanguageProfile;
    expect(detectTestCommand(npm, [python])).toBe("python -m pytest -q");
    expect(detectTestCommand(join(base, "none"), [])).toBeUndefined();
    // A plain Node project with node:test files (live test: garuda-live had no test script).
    const plain = join(base, `d${n++}`);
    write(plain, { "test/math.test.js": "" });
    expect(detectTestCommand(plain, [])).toBe("node --test");
  });

  it("flags what stops a merge and what needs a look", () => {
    expect(riskFlags({ result: done, test: "t", before: pass, after: pass })).toEqual([]);
    expect(riskFlags({ result: done, test: "t", before: pass, after: fail })).toEqual([
      { level: "stop", text: "The tests passed before the job and fail after it." },
    ]);
    const flags = riskFlags({
      result: {
        stopReason: "max_steps",
        denied: [{ tool: "bash", target: "curl" }],
        files: [
          { status: "deleted", path: "test/old.test.ts" },
          { status: "modified", path: "src/a.spec.ts", added: 1, removed: 1 },
          { status: "modified", path: "package.json", added: 2, removed: 0 },
          { status: "added", path: ".github/workflows/ci.yml", added: 600, removed: 0 },
        ],
      },
    }).map((f) => `${f.level}: ${f.text}`);
    expect(flags).toEqual([
      'stop: The job did not finish: it stopped with "max_steps".',
      "look: No test command: nothing proves the change works.",
      "look: Test files deleted: test/old.test.ts.",
      "look: Existing tests changed: src/a.spec.ts. Check that they still test what they did.",
      "look: Dependencies or build files changed: package.json.",
      "look: CI, container or environment files changed: .github/workflows/ci.yml.",
      "look: A large change: 4 files, 604 lines.",
      "look: 1 call(s) were denied: the job may be incomplete.",
    ]);
  });

  it("the reviewer: a principal engineer of the stack, the facts, a diff cut to size, a strict verdict", () => {
    const stack = stackOf(
      [{ path: "src/a.ts" }, { path: "b.py" }],
      [{ label: "Python (pytest)" } as LanguageProfile],
    );
    expect(stack).toEqual(["TypeScript", "Python", "Python (pytest)"]);
    expect(reviewerSystem(stack)).toContain(
      "principal engineer and a domain expert in TypeScript, Python",
    );
    const prompt = reviewPrompt({
      prompt: "Fix add",
      files: [{ status: "modified", path: "src/a.ts", added: 1, removed: 1 }],
      test: "npm test",
      before: fail,
      after: pass,
      flags: [],
      diff: "x".repeat(REVIEW_DIFF_CHARS + 5),
    });
    expect(prompt).toContain(
      "Tests (npm test): before the job fail (exit code 1) in 2 s; after it pass in 1 s",
    );
    expect(prompt).toContain("[… the diff is cut here; 5 more characters]");
    expect(parseReview("VERDICT: ready\nSUMMARY: fine").verdict).toBe("ready");
    expect(parseReview("verdict: Needs a look").verdict).toBe("needs-look");
    expect(parseReview("Looks good to me").verdict).toBe("needs-look");
    expect(jobVerdict([], undefined)).toBe("ready");
    expect(jobVerdict([{ level: "look", text: "x" }], "ready")).toBe("ready");
    expect(jobVerdict([{ level: "stop", text: "x" }], "ready")).toBe("needs-look");
    expect(tail(["a", "b", "c"].join("\n"), 2)).toBe("[… 1 lines]\nb\nc");
    expect(jobPrompt("r", "p")).toContain("Work as a staff engineer");
  });
});

describe("proof of work: a whole job (0.11)", () => {
  it("tests before and after, no test output committed, the review, the verdict in the report", async () => {
    const dir = join(base, `r${n++}`);
    const root = join(dir, "project");
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    write(root, {
      "src/math.js": "export const add = (a, b) => a - b;\n",
      // The check writes an output file, as coverage tools do; it must not reach the commit.
      "check.mjs":
        'import { writeFileSync } from "node:fs";\nimport { add } from "./src/math.js";\nwriteFileSync("coverage.txt", "x");\nif (add(2, 3) !== 5) { console.log("add(2, 3) is wrong"); process.exit(1); }\nconsole.log("ok");\n',
      ".gitignore": ".garuda/sessions/\n",
      ".garuda/settings.json": JSON.stringify({ executor: "host" }),
    });
    const g = (...args: string[]) => git(host, root, args);
    await g("init", "-q", "-b", "main");
    await g("config", "user.email", "dev@example.com");
    await g("config", "user.name", "Dev");
    await g("add", "-A");
    await g("commit", "-q", "-m", "start");

    const created = await createJob({
      root,
      executor: new SandboxedHost(),
      approver: new AutoApprover("once"),
      plan: {
        request: "Fix add",
        plan: "1. Use + in add.\n\n```permissions\nedit_file(src/math.js)\n```",
        sessionId: "s1",
      },
      modelId: "fake",
      home,
      test: `${process.execPath} check.mjs`,
      signal: new AbortController().signal,
    });
    if (!created.ok) throw new Error(created.text);
    expect(created.job.test).toBe(`${process.execPath} check.mjs`);
    const prepared = await prepareJob(root, created.job.id, undefined, quiet, host);
    if (typeof prepared === "number") throw new Error(`exit ${prepared}`);

    let reviewed = "";
    const model = new FakeModelClient([
      reply([toolUse("read_file", { path: "src/math.js" }, "r1")]),
      reply([
        toolUse(
          "edit_file",
          { path: "src/math.js", old_string: "a - b", new_string: "a + b" },
          "e1",
        ),
      ]),
      reply([text("Fixed add; the check passes.")]),
      (request) => {
        reviewed = `${request.system}\n${JSON.stringify(request.messages)}`;
        expect(request.tools).toEqual([]);
        return reply([text("VERDICT: ready\nSUMMARY: The fix is correct.\nFINDINGS:\n- none")]);
      },
    ]);
    const runtime = await Runtime.create({
      root: prepared.root,
      modelId: "fake",
      model: async () => model,
      approver: new AutoApprover("deny"),
      store: new FileSessionStore(root),
      settings: prepared.settings,
      unattended: { reason: JOB_DENIAL, onDeny: () => {} },
      mcp: false,
      hooks: false,
      profiles: [],
    });
    await testsBefore(prepared, runtime, quiet, host);
    expect(prepared.testsBefore?.exitCode).toBe(1);
    const result = await runtime.runTurn(prepared.job.prompt, new AbortController().signal);
    await finishJob(prepared, { kind: "done", result }, runtime, quiet, host);

    expect(reviewed).toContain("principal engineer and a domain expert in JavaScript");
    expect(reviewed).toContain("-export const add = (a, b) => a - b;");
    expect(reviewed).toContain("before the job fail (exit code 1)");
    const job = await loadJob(root, created.job.id);
    expect(job.result?.proof?.verdict).toBe("ready");
    expect(job.result?.proof?.after?.exitCode).toBe(0);
    expect(job.result?.proof?.flags).toEqual([
      {
        level: "look",
        text: "The tests failed before the job and pass after it: check that the change is why.",
      },
    ]);
    const tree = (await git(host, root, ["ls-tree", "-r", "--name-only", job.branch])).stdout;
    expect(tree).not.toContain("coverage.txt");
    const report = readFileSync(join(root, ".garuda/jobs", `${job.id}.md`), "utf8");
    expect(report).toContain("## Verdict\n\n**Ready to merge**");
    expect(report).toContain("before the job fail (exit code 1)");
    expect(report).toContain("## Review by a principal engineer");
    expect(report).toContain("SUMMARY: The fix is correct.");
    expect(model.remaining).toBe(0);
  });
});
