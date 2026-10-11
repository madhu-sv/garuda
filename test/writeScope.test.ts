import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git } from "../src/jobs/git.js";
import { type Job, parseJob } from "../src/jobs/job.js";
import { outsideScope } from "../src/jobs/worktree.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { CallTarget, PermissionRequest } from "../src/permissions/types.js";
import {
  inWriteScope,
  prepareWriteScope,
  proposeWriteScope,
  scopeEntryProblem,
} from "../src/permissions/writeScope.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { findOsSandbox } from "../src/sandbox/index.js";
import { seatbeltProfile } from "../src/sandbox/seatbelt.js";
import { FileTracker } from "../src/session/fileTracker.js";
import { editFileTool } from "../src/tools/editFile.js";
import { writeFileTool } from "../src/tools/writeFile.js";

/** Job write scopes (0.17, review T6; docs/lld/bounded-changes.md). */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-scope-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let count = 0;
function folder(): string {
  const dir = join(base, `p${count++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const signal = new AbortController().signal;
const edit = (path: string): PermissionRequest => ({
  tool: "edit_file",
  readOnly: false,
  info: { target: { kind: "path", path } as CallTarget },
});

function engine(root: string, writeScope?: string[], policy?: { denyPaths: string[] }) {
  const settings = parseSettings({ permissions: { allow: ["edit_file"] } });
  return new PermissionEngine({
    root,
    approver: new AutoApprover("deny"),
    settings: writeScope === undefined ? settings : { ...settings, writeScope },
    isolation: "os",
    ...(policy === undefined ? {} : { policy }),
  });
}

describe("scope entries", () => {
  it("refuses the root, absolute paths, .., protected folders and control characters", () => {
    for (const bad of ["", ".", "./", "/", "/etc/", "../x/", "src/../../x", ".git/", ".garuda/x"]) {
      expect(scopeEntryProblem(bad), bad).toBeDefined();
    }
    expect(scopeEntryProblem("a\nb/")).toBeDefined();
    for (const good of ["src/", "README.md", "src/main/java/", "target/"]) {
      expect(scopeEntryProblem(good), good).toBeUndefined();
    }
    expect(() => parseJobWith({ writeScope: ["../x/"] })).toThrow();
  });

  it("a folder entry covers its files; a file entry only itself", () => {
    expect(inWriteScope("src/a.ts", ["src/"])).toBe(true);
    expect(inWriteScope("src", ["src/"])).toBe(true);
    expect(inWriteScope("srcx/a.ts", ["src/"])).toBe(false);
    expect(inWriteScope("README.md", ["README.md"])).toBe(true);
    expect(inWriteScope("README.md.bak", ["README.md"])).toBe(false);
  });

  it("/schedule proposes the rules' folders and the build output folders", () => {
    const root = folder();
    writeFileSync(join(root, "pom.xml"), "<project/>");
    expect(
      proposeWriteScope(
        ["edit_file(src/**)", "write_file(test/FooTest.java)", "bash(mvn -q test)"],
        root,
      ),
    ).toEqual({ scope: ["src/", "target/", "test/FooTest.java"] });
    const open = proposeWriteScope(["edit_file(**/*.ts)"], root);
    expect(open.scope).toBeUndefined();
    expect(JSON.stringify(open)).toContain("names no folder");
  });
});

describe("the permission engine with a write scope", () => {
  it("denies an edit outside the scope, also with an allow rule", async () => {
    const root = folder();
    // Negative control: without a scope, the allow rule lets both edits run.
    expect((await engine(root).check(edit("pom.xml"), signal)).allowed).toBe(true);
    const scoped = engine(root, ["src/"]);
    expect((await scoped.check(edit("src/a.ts"), signal)).allowed).toBe(true);
    const outside = await scoped.check(edit("pom.xml"), signal);
    expect(outside.allowed).toBe(false);
    expect(outside.allowed === false && outside.reason).toContain("write scope");
  });

  it("the sandbox policy: the root is read-only except the scope; denied paths stay denied", () => {
    const root = folder();
    const policy = engine(root, ["src/"], { denyPaths: ["src/secret.txt"] });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "secret.txt"), "x");
    const exec = policy.execPolicy(1_000);
    expect(exec.writeScope).toEqual({ root, paths: [join(root, "src")] });
    expect(exec.writePaths).not.toContain(root);
    const profile = seatbeltProfile(exec);
    const deny = profile.indexOf(`(deny file-write* (subpath "${root}"))`);
    const allow = profile.indexOf(`(allow file-write* (subpath "${join(root, "src")}"))`);
    const secret = profile.lastIndexOf(join(root, "src", "secret.txt"));
    expect(deny).toBeGreaterThan(-1);
    expect(allow).toBeGreaterThan(deny);
    expect(secret).toBeGreaterThan(allow);
    // Plan mode or no scope: unchanged.
    expect(engine(root).execPolicy(1_000).writeScope).toBeUndefined();
  });
});

function parseJobWith(over: Record<string, unknown>): Job {
  return parseJob({
    version: 1,
    id: "j1",
    title: "t",
    createdAt: new Date().toISOString(),
    root: "/r",
    base: "a".repeat(40),
    branch: "garuda/job-j1",
    worktree: "/w",
    prompt: "p",
    allow: [],
    onUnapproved: "deny-and-continue",
    maxSteps: 10,
    links: [],
    status: "scheduled",
    ...over,
  });
}

describe("before and after a job", () => {
  it("refuses a scope entry through a symbolic link; creates missing folders", () => {
    const root = folder();
    const elsewhere = folder();
    symlinkSync(elsewhere, join(root, "out"));
    expect(prepareWriteScope(root, ["out/"])).toContain("symbolic link");
    expect(prepareWriteScope(root, ["target/", "src/"])).toBeUndefined();
    expect(existsSync(join(root, "target"))).toBe(true);
  });

  it("lists changes outside the scope before the commit", async () => {
    const worktree = folder();
    const host = new HostExecutor();
    await git(host, worktree, ["init", "-q"]);
    mkdirSync(join(worktree, "src"));
    writeFileSync(join(worktree, "src", "a.ts"), "a");
    writeFileSync(join(worktree, "build.sh"), "echo");
    const job = parseJobWith({ worktree, writeScope: ["src/"] });
    expect(await outsideScope(host, job)).toEqual(["build.sh"]);
    // Negative control: without a scope, nothing is outside.
    expect(await outsideScope(host, parseJobWith({ worktree }))).toEqual([]);
  });
});

const found = findOsSandbox();
describe.runIf("executor" in found)("a job's command in the OS sandbox", () => {
  it("writes in the scope, not elsewhere in the worktree, not a denied path in the scope", async () => {
    const executor = (found as { executor: import("../src/sandbox/types.js").Executor }).executor;
    const root = folder();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "secret.txt"), "keep");
    const run = (scope?: string[]) =>
      executor.run(
        "echo in > src/in.txt; echo out > out.txt; echo bad > src/secret.txt; true",
        engine(root, scope, { denyPaths: ["src/secret.txt"] }).execPolicy(10_000),
      );
    // Negative control: without a scope the command writes out.txt.
    await run();
    expect(existsSync(join(root, "out.txt"))).toBe(true);
    rmSync(join(root, "out.txt"));

    await run(["src/"]);
    expect(readFileSync(join(root, "src", "in.txt"), "utf8")).toBe("in\n");
    expect(existsSync(join(root, "out.txt"))).toBe(false);
    expect(readFileSync(join(root, "src", "secret.txt"), "utf8")).toBe("keep");
    executor.shutdown();
  });
});

describe("scope bypasses (third review)", () => {
  const bashOutside: PermissionRequest = {
    tool: "bash",
    readOnly: false,
    info: { target: { kind: "command", command: "touch docs/out.txt", outsideSandbox: true } },
  };
  function jobEngine(root: string, scope?: string[], unattended = true) {
    const settings = parseSettings({ permissions: { allow: ["bash", "edit_file", "write_file"] } });
    return new PermissionEngine({
      root,
      approver: new AutoApprover("deny"),
      settings: scope === undefined ? settings : { ...settings, writeScope: scope },
      isolation: "os",
      ...(unattended ? { unattended: { reason: "job" } } : {}),
    });
  }

  it("a job never runs a command outside the sandbox, also with a bash allow rule", async () => {
    const root = folder();
    // Negative control: in the chat, the allow rule lets it run.
    expect((await jobEngine(root, undefined, false).check(bashOutside, signal)).allowed).toBe(true);
    for (const engine of [
      jobEngine(root, ["src/"]),
      jobEngine(root),
      jobEngine(root, ["src/"], false),
    ]) {
      const d = await engine.check(bashOutside, signal);
      expect(d.allowed).toBe(false);
      expect(d.allowed === false && d.reason).toContain("only in the OS sandbox");
    }
  });

  function linked(): string {
    const root = folder();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "private.txt"), "keep\n");
    symlinkSync("../docs/private.txt", join(root, "src", "alias.txt"));
    symlinkSync("../docs", join(root, "src", "alias"));
    return root;
  }

  it("the engine checks the place that a link reaches", async () => {
    const root = linked();
    // Negative control: without a scope, both edits are allowed by the rule.
    expect((await jobEngine(root).check(edit("src/alias.txt"), signal)).allowed).toBe(true);
    const scoped = jobEngine(root, ["src/"]);
    const viaFile = await scoped.check(edit("src/alias.txt"), signal);
    expect(viaFile.allowed).toBe(false);
    expect(viaFile.allowed === false && viaFile.reason).toContain("leads to docs/private.txt");
    const viaFolder = await scoped.check(edit("src/alias/new.txt"), signal);
    expect(viaFolder.allowed).toBe(false);
    expect((await scoped.check(edit("src/real.txt"), signal)).allowed).toBe(true);
  });

  it("the write tools check again just before they write", async () => {
    const root = linked();
    const context = (permissions: PermissionEngine) => ({
      root,
      signal,
      permissions,
      files: new FileTracker(),
    });
    // The run skips the permission check, as when a link changes after it.
    await expect(
      writeFileTool.run(
        { path: "src/alias/new.txt", content: "x" },
        context(jobEngine(root, ["src/"])),
      ),
    ).rejects.toThrow(/Nothing was written/);
    expect(existsSync(join(root, "docs", "new.txt"))).toBe(false);

    const files = new FileTracker();
    const before = readFileSync(join(root, "src", "alias.txt"), "utf8");
    files.record(join(root, "src", "alias.txt"), before);
    await expect(
      editFileTool.run(
        { path: "src/alias.txt", old_string: "keep", new_string: "changed" },
        { ...context(jobEngine(root, ["src/"])), files },
      ),
    ).rejects.toThrow(/Nothing was written/);
    expect(readFileSync(join(root, "docs", "private.txt"), "utf8")).toBe("keep\n");

    // Negative control: without a scope, the write through the link lands in docs/.
    await writeFileTool.run({ path: "src/alias/new.txt", content: "x" }, context(jobEngine(root)));
    expect(existsSync(join(root, "docs", "new.txt"))).toBe(true);
  });
});
