import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { runCommand } from "../src/cli/chat/commands.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { finishJob, msUntil, prepareJob } from "../src/cli/jobCommand.js";
import { createJob } from "../src/jobs/create.js";
import { git } from "../src/jobs/git.js";
import { loadJob, planPermissions, planTitle, saveJob } from "../src/jobs/job.js";
import { agentPath, agentPlist, nextTime } from "../src/jobs/launchd.js";
import { jobBase, worktreeDir } from "../src/jobs/worktree.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { JOB_DENIAL, PermissionEngine } from "../src/permissions/engine.js";
import { parseRule } from "../src/permissions/rules.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { CallTarget } from "../src/permissions/types.js";
import { HostExecutor } from "../src/sandbox/host.js";
import type { Executor } from "../src/sandbox/types.js";
import { FileSessionStore } from "../src/session/store.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-jobs-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const signal = () => new AbortController().signal;
const host = new HostExecutor();
/** Git and files as on the host, but reported as sandboxed: createJob needs an OS sandbox. */
class SandboxedHost extends HostExecutor {
  override readonly isolation = "os" as unknown as "none";
}
const quiet = { event: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function write(top: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const file = join(top, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** A git repository with one commit, its own identity, and a node_modules folder (ignored). */
async function repo(files: Record<string, string> = {}): Promise<{ root: string; home: string }> {
  const dir = join(base, `r${n++}`);
  const root = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  write(root, {
    "src/math.js": "export const add = (a, b) => a - b;\n",
    ".gitignore": "node_modules/\n.garuda/sessions/\n",
    "node_modules/dep/index.js": "module.exports = 1;\n",
    ".garuda/settings.json": JSON.stringify({ executor: "host" }),
    ...files,
  });
  const g = (...args: string[]) => git(host, root, args);
  await g("init", "-q", "-b", "main");
  await g("config", "user.email", "dev@example.com");
  await g("config", "user.name", "Dev");
  await g("add", "-A");
  await g("commit", "-q", "-m", "start");
  return { root, home };
}

const PLAN = [
  "1. Change src/math.js: add uses + instead of -.",
  "2. Add test/math.test.js.",
  "",
  "```permissions",
  "edit_file(src/math.js)",
  "- write_file(test/**)",
  "# a comment",
  "not a rule (",
  "```",
].join("\n");

describe("scheduled jobs: the plan's permissions (0.7)", () => {
  it("reads one rule per line from the ```permissions block", () => {
    expect(planPermissions(PLAN)).toEqual({
      rules: ["edit_file(src/math.js)", "write_file(test/**)"],
      problems: ["not a rule ("],
    });
    expect(planPermissions("no block")).toEqual({ rules: [], problems: [] });
    expect(planTitle("  \nFix the add bug in src/math.js\nmore", PLAN)).toBe(
      "Fix the add bug in src/math.js",
    );
  });

  it("an unattended engine denies what would ask, records it, and allows the job's rules", async () => {
    const denied: string[] = [];
    const engine = new PermissionEngine({
      root: "/r",
      approver: new AutoApprover("once"),
      settings: { ...parseSettings({}), allow: [parseRule("edit_file(src/**)")] },
      isolation: "os",
      unattended: {
        reason: JOB_DENIAL,
        onDeny: (tool, target: CallTarget) =>
          denied.push(`${tool} ${target.kind === "path" ? target.path : target.kind}`),
      },
    });
    const check = (tool: string, target: CallTarget) =>
      engine.check({ tool, readOnly: false, info: { target, preview: "" } }, signal());
    expect(await check("edit_file", { kind: "path", path: "src/a.js" })).toMatchObject({
      allowed: true,
      by: "rule",
    });
    expect(await check("bash", { kind: "command", command: "pnpm test" })).toMatchObject({
      allowed: true,
      by: "sandbox",
    });
    expect(await check("write_file", { kind: "path", path: "other.txt" })).toEqual({
      allowed: false,
      by: "unattended",
      reason: JOB_DENIAL,
    });
    expect(denied).toEqual(["write_file other.txt"]);
  });

  it("waits until the next HH:MM", () => {
    const now = new Date(2026, 8, 27, 23, 30, 0);
    expect(msUntil(1, 0, now)).toBe(90 * 60_000);
    expect(msUntil(23, 45, now)).toBe(15 * 60_000);
  });
});

describe("scheduled jobs: create, run, report (0.7)", () => {
  it("/schedule's job: base, branch, worktree, links, the approved list; No saves nothing", async () => {
    const { root, home } = await repo();
    const plan = { request: "Fix the add bug", plan: PLAN, sessionId: "s1" };
    const options = {
      root,
      executor: new SandboxedHost(),
      plan,
      modelId: "claude-sonnet-5",
      at: "01:00",
      home,
      now: new Date(2026, 8, 27, 23, 0),
      signal: signal(),
    };
    const no = await createJob({ ...options, approver: new AutoApprover("deny") });
    expect(no).toEqual({ ok: false, text: "No job was created." });

    const approver = new AutoApprover("once");
    const created = await createJob({ ...options, approver });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const job = await loadJob(root, created.job.id);
    expect(job).toMatchObject({
      title: "Fix the add bug",
      allow: ["edit_file(src/math.js)", "write_file(test/**)"],
      branch: `garuda/job-${job.id}`,
      worktree: worktreeDir(root, job.id, home),
      links: ["node_modules"],
      at: "01:00",
      maxSteps: 100,
      status: "scheduled",
    });
    expect(job.id).toMatch(/^20260927-2300-[0-9a-f]{4}$/);
    expect(job.prompt).toContain("<request>\nFix the add bug\n</request>");
    expect(job.prompt).toContain("nobody can answer questions or approve calls");
    expect(approver.requests[0]?.preview).toContain("  edit_file(src/math.js)");
    expect(approver.requests[0]?.preview).toContain("Not rules, left out:\n  not a rule (");
    expect(created.text).toContain(`garuda run ${job.id} --at 01:00`);
    // No launchd option: no second question and no agent, also on macOS.
    expect(approver.requests).toHaveLength(1);
    expect(job.batch).toBeUndefined();

    // A Claude model: a second question about the Batch API; yes sets it with the finish-by time.
    const asked = new AutoApprover("once");
    const batched = await createJob({ ...options, approver: asked, batchCapable: true });
    if (!batched.ok) throw new Error(batched.text);
    expect(asked.requests[1]).toMatchObject({ title: "Use the Batch API for this job?" });
    expect(asked.requests[1]?.preview).toContain(
      "At 06:45 (15 minutes before the finish-by time 07:00)",
    );
    expect(asked.requests[1]?.preview).toContain("more than 20 minutes runs on the normal API");
    expect(await loadJob(root, batched.job.id)).toMatchObject({
      batch: true,
      finishBy: "07:00",
      stepLimitMinutes: 20,
    });
    const { jobReport } = await import("../src/jobs/text.js");
    expect(
      jobReport({
        ...batched.job,
        status: "done",
        result: {
          stopReason: "done",
          steps: 3,
          tokens: 1000,
          durationMs: 1000,
          files: [],
          denied: [],
          answer: "",
          modelCalls: { batch: 2, normal: 1, switchedAt: "2026-09-28T05:45:00.000Z" },
        },
      }),
    ).toContain(
      "- Model calls: 2 through the Batch API, 1 normal; the rest normal from 2026-09-28T05:45:00.000Z",
    );
  });

  it("a dirty checkout: the base is one plain commit on HEAD with the uncommitted changes", async () => {
    const { root } = await repo();
    writeFileSync(join(root, "src/math.js"), "export const add = (a, b) => a + b; // wip\n");
    writeFileSync(join(root, "new.txt"), "untracked\n");
    write(root, { ".garuda/jobs/x.json": "{}" });
    const b = await jobBase(host, root);
    expect(b.uncommitted).toBe(true);
    expect(b.untracked).toBe(1);
    const parents = (await git(host, root, ["rev-list", "--parents", "-n", "1", b.commit])).stdout
      .trim()
      .split(" ");
    expect(parents).toHaveLength(2);
    expect((await git(host, root, ["show", `${b.commit}:src/math.js`])).stdout).toContain("wip");
    // The checkout itself did not change.
    expect(readFileSync(join(root, "src/math.js"), "utf8")).toContain("wip");
    expect((await git(host, root, ["stash", "list"])).stdout).toBe("");
  });

  it("without git, or with the host executor, there is no job", async () => {
    const dir = join(base, `plain${n++}`);
    mkdirSync(dir);
    const plan = { request: "x", plan: "y", sessionId: "s" };
    const common = { approver: new AutoApprover("once"), plan, modelId: "m", signal: signal() };
    expect((await createJob({ ...common, root: dir, executor: new SandboxedHost() })).text).toMatch(
      /needs a git repository/,
    );
    expect((await createJob({ ...common, root: dir, executor: host })).text).toMatch(
      /needs the OS sandbox/,
    );
  });

  it("runs unattended in the worktree: approved edits land on the job branch, the rest is denied and reported", async () => {
    const { root, home } = await repo();
    const created = await createJob({
      root,
      executor: new SandboxedHost(),
      approver: new AutoApprover("once"),
      plan: { request: "Fix the add bug", plan: PLAN, sessionId: "s1" },
      modelId: "fake",
      home,
      signal: signal(),
    });
    if (!created.ok) throw new Error(created.text);
    const id = created.job.id;

    const prepared = await prepareJob(root, id, undefined, quiet, host);
    if (typeof prepared === "number") throw new Error(`exit ${prepared}`);
    expect(prepared.root).toBe(created.job.worktree);
    expect(existsSync(join(prepared.root, "node_modules/dep/index.js"))).toBe(true);
    expect((await loadJob(root, id)).status).toBe("running");

    const model = new FakeModelClient([
      (request) => {
        expect(JSON.stringify(request.messages[0])).toContain("scheduled job");
        return reply([toolUse("read_file", { path: "src/math.js" }, "r1")]);
      },
      reply([
        toolUse(
          "edit_file",
          { path: "src/math.js", old_string: "a - b", new_string: "a + b" },
          "e1",
        ),
        toolUse("write_file", { path: "notes.txt", content: "not approved\n" }, "w1"),
      ]),
      (request) => {
        expect(JSON.stringify(request.messages.at(-1))).toContain("not in the approved list");
        return reply([text("Fixed add. notes.txt was denied.")]);
      },
    ]);
    const runtime = await Runtime.create({
      root: prepared.root,
      modelId: "fake",
      model: async () => model,
      approver: new AutoApprover("deny"),
      store: new FileSessionStore(root),
      settings: prepared.settings,
      unattended: {
        reason: JOB_DENIAL,
        onDeny: (tool, target) =>
          prepared.denied.push({
            tool,
            target: target.kind === "path" ? target.path : target.kind,
          }),
      },
      mcp: false,
      hooks: false,
      profiles: [],
    });
    const result = await runtime.runTurn(prepared.job.prompt, signal());
    await finishJob(prepared, { kind: "done", result }, runtime, quiet, host);

    const job = await loadJob(root, id);
    expect(job.status).toBe("done");
    expect(job.result?.files).toEqual([
      { status: "modified", path: "src/math.js", added: 1, removed: 1 },
    ]);
    expect(job.result?.denied).toEqual([{ tool: "write_file", target: "notes.txt" }]);
    expect(job.result?.answer).toBe("Fixed add. notes.txt was denied.");
    // The branch has the change; the checkout does not; links and sessions are not committed.
    const onBranch = await git(host, root, ["show", `${job.branch}:src/math.js`]);
    expect(onBranch.stdout).toContain("a + b");
    expect(readFileSync(join(root, "src/math.js"), "utf8")).toContain("a - b");
    const tree = (await git(host, root, ["ls-tree", "-r", "--name-only", job.branch])).stdout;
    expect(tree).not.toContain("node_modules");
    expect(tree).not.toContain(".garuda/sessions");
    expect(existsSync(join(root, ".garuda/sessions", `${job.result?.sessionId}.jsonl`))).toBe(true);
    const report = readFileSync(join(root, ".garuda/jobs", `${id}.md`), "utf8");
    expect(report).toContain("- Status: done (done)");
    expect(report).toContain("- modified src/math.js (+1 −1)");
    expect(report).toContain("## Denied calls");
    expect(report).toContain("- write_file: notes.txt");
    expect(report).toContain(`git merge ${job.branch}`);

    // A done job does not run again.
    expect(await prepareJob(root, id, undefined, quiet, host)).toBe(1);
  });

  it("the chat: a finished plan can be scheduled; /jobs lists jobs and shows one", async () => {
    const { root } = await repo();
    const model = new FakeModelClient([reply([text(PLAN)])]);
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: async () => model,
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      profiles: [],
      mode: "plan",
    });
    const store = new ChatStore({ model: "m", sandbox: "none" }, { paint: noColor });
    const run = (line: string) =>
      runCommand(line, { runtime, renderer: store, sessionPath: (id) => id });
    const said = () => store.getState().items.map((i) => i.text);
    await run("/schedule");
    expect(said().at(-1)).toMatch(/no finished plan/);
    await runtime.runTurn("Fix the add bug", signal());
    expect(runtime.lastPlan).toMatchObject({ request: "Fix the add bug", plan: PLAN });
    // The host executor has no sandbox: the job is refused with the reason.
    await run("/schedule 01:00");
    expect(said().at(-1)).toMatch(/needs the OS sandbox/);

    await run("/jobs");
    expect(said().at(-1)).toMatch(/No jobs in this project/);
    const created = await createJob({
      root,
      executor: new SandboxedHost(),
      approver: new AutoApprover("once"),
      plan: runtime.lastPlan as NonNullable<typeof runtime.lastPlan>,
      modelId: "fake",
      signal: signal(),
    });
    if (!created.ok) throw new Error(created.text);
    await run("/jobs");
    expect(said().at(-1)).toContain(`${created.job.id}  Fix the add bug\n    scheduled`);
    await run(`/jobs ${created.job.id}`);
    expect(said().at(-1)).toContain(`# Garuda job ${created.job.id}: Fix the add bug`);
    await run("/jobs nope-1");
    expect(said().at(-1)).toMatch(/There is no job nope-1/);
    // A hand-edited file with a bad rule is refused when loaded.
    await saveJob({ ...created.job, allow: ["edit_file(("] });
    await expect(loadJob(root, created.job.id)).rejects.toThrow();
  });
});

/** The host for git; launchctl and osascript are only recorded. */
function recording(): { executor: Executor; commands: string[] } {
  const commands: string[] = [];
  const executor = Object.create(host) as Executor;
  executor.run = async (command, policy, options) => {
    if (/^(launchctl|osascript) /.test(command)) {
      commands.push(command);
      const out = { text: "", truncated: false, totalBytes: 0 };
      return {
        exitCode: 0,
        signal: null,
        stdout: out,
        stderr: out,
        timedOut: false,
        aborted: false,
        durationMs: 0,
      };
    }
    return host.run(command, policy, options);
  };
  return { executor, commands };
}

describe("scheduled jobs: launchd (0.7)", () => {
  const env = (home: string) => ({
    home,
    uid: 501,
    shell: "/bin/zsh",
    node: "/opt/homebrew/bin/node",
    script: "/Users/me/dev/garuda/dist/cli/index.js",
  });

  it("the agent: login shell under caffeinate, the job's date and time, the log, escaped XML", () => {
    const job = {
      id: "20260927-2300-ab12",
      root: "/Users/me/dev/a&b project",
      at: "01:00",
    } as Parameters<typeof agentPlist>[0];
    const when = nextTime("01:00", new Date(2026, 8, 27, 23, 0));
    expect(when.getDate()).toBe(28);
    const plist = agentPlist(job, env("/Users/me"), when);
    expect(plist).toContain("<string>dev.garuda.job.20260927-2300-ab12</string>");
    expect(plist).toContain(
      "<string>/usr/bin/caffeinate</string>\n      <string>-i</string>\n      <string>/bin/zsh</string>\n      <string>-lic</string>",
    );
    expect(plist).toContain(
      "<string>cd '/Users/me/dev/a&amp;b project' &amp;&amp; exec /opt/homebrew/bin/node /Users/me/dev/garuda/dist/cli/index.js run 20260927-2300-ab12 --from-launchd</string>",
    );
    expect(plist).toMatch(
      /<key>Month<\/key><integer>9<\/integer>\n.*<key>Day<\/key><integer>28<\/integer>\n.*<key>Hour<\/key><integer>1<\/integer>\n.*<key>Minute<\/key><integer>0<\/integer>/,
    );
    expect(plist).toContain("<key>RunAtLoad</key><false/>");
    expect(plist).toContain(
      "<key>StandardOutPath</key><string>/Users/me/dev/a&amp;b project/.garuda/jobs/20260927-2300-ab12.log</string>",
    );
    // The single binary: no script after it.
    const sea = agentPlist(
      job,
      { ...env("/Users/me"), node: "/usr/local/bin/garuda", script: "/usr/local/bin/garuda" },
      when,
    );
    expect(sea).toContain("exec /usr/local/bin/garuda run 20260927-2300-ab12");
  });

  it("/schedule HH:MM on macOS offers the agent; yes installs it, /jobs cancel removes it", async () => {
    const { root, home } = await repo();
    const { executor, commands } = recording();
    const approver = new AutoApprover("once");
    const created = await createJob({
      root,
      executor: new SandboxedHost(),
      approver,
      plan: { request: "Fix the add bug", plan: PLAN, sessionId: "s1" },
      modelId: "m",
      at: "01:00",
      home,
      now: new Date(2026, 8, 27, 23, 0),
      signal: signal(),
      launchd: { platform: "darwin", env: env(home), executor },
    });
    if (!created.ok) throw new Error(created.text);
    const id = created.job.id;
    expect(approver.requests[1]).toMatchObject({
      title: "Run the job at 01:00 with launchd?",
      choices: ["once", "deny"],
    });
    expect(approver.requests[1]?.preview).toContain("/bin/zsh -lic");
    expect(created.text).toContain("launchd starts it at 01:00 on Mon Sep 28 2026");
    const plist = agentPath(home, id);
    expect(readFileSync(plist, "utf8")).toContain(`run ${id} --from-launchd`);
    expect(commands).toEqual([
      `launchctl bootout gui/501/dev.garuda.job.${id}`,
      `launchctl bootstrap gui/501 ${plist}`,
    ]);
    expect((await loadJob(root, id)).launchd?.label).toBe(`dev.garuda.job.${id}`);

    // No on Linux, or No to the second question: the terminal command instead.
    const linux = await createJob({
      root,
      executor: new SandboxedHost(),
      approver: new AutoApprover("once"),
      plan: { request: "x", plan: PLAN, sessionId: "s1" },
      modelId: "m",
      at: "02:00",
      home,
      signal: signal(),
      launchd: { platform: "linux", env: env(home), executor },
    });
    expect(linux.text).toMatch(/garuda run \S+ --at 02:00/);

    // /jobs cancel: the agent goes, the job is stopped.
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: async () => new FakeModelClient([]),
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      profiles: [],
    });
    commands.length = 0;
    expect(await runtime.cancelJob(id, { env: env(home), executor })).toMatch(
      /is cancelled and its launchd agent is removed/,
    );
    expect(existsSync(plist)).toBe(false);
    expect(commands).toEqual([`launchctl bootout gui/501/dev.garuda.job.${id}`]);
    expect((await loadJob(root, id)).status).toBe("stopped");
    expect(await runtime.cancelJob(id)).toMatch(/is stopped: there is nothing to cancel/);
  });
});
