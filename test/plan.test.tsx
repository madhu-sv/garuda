import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterAll, describe, expect, it } from "vitest";
import { PLAN_NOTE, Runtime } from "../src/app/runtime.js";
import { runCommand } from "../src/cli/chat/commands.js";
import { runChat, statusOf } from "../src/cli/chat/controller.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { BUILD_PROMPT, planHandoff } from "../src/cli/chat/plan.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { App, onKey } from "../src/cli/chat/ui.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { ToolResultBlock } from "../src/model/types.js";
import { PermissionEngine, PLAN_MODE_DENIAL } from "../src/permissions/engine.js";
import { parseSettings } from "../src/permissions/settings.js";
import type {
  AgentMode,
  ApprovalChoice,
  ApprovalRequest,
  Approver,
  CallTarget,
} from "../src/permissions/types.js";
import { findOsSandbox } from "../src/sandbox/index.js";
import type { Isolation } from "../src/sandbox/types.js";
import { FileSessionStore } from "../src/session/store.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-plan-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const signal = new AbortController().signal;

class Recorder implements Approver {
  readonly requests: ApprovalRequest[] = [];
  constructor(private readonly answer: ApprovalChoice = "once") {}
  async ask(request: ApprovalRequest): Promise<ApprovalChoice> {
    this.requests.push(request);
    return this.answer;
  }
}

function engine(
  mode: AgentMode,
  isolation: Isolation = "os",
  allow: string[] = [],
  deny: string[] = [],
) {
  const approver = new Recorder();
  const permissions = new PermissionEngine({
    root: "/repo",
    approver,
    isolation,
    settings: parseSettings({ permissions: { allow, deny } }),
    mode: () => mode,
  });
  const check = (tool: string, readOnly: boolean, target?: CallTarget) =>
    permissions.check(
      target === undefined ? { tool, readOnly } : { tool, readOnly, info: { target, preview: "" } },
      signal,
    );
  return { approver, permissions, check };
}

const file = (path: string): CallTarget => ({ kind: "path", path });
const command = (text: string, outsideSandbox = false): CallTarget => ({
  kind: "command",
  command: text,
  ...(outsideSandbox ? { outsideSandbox } : {}),
});
const url = (host: string, alwaysAsk = false): CallTarget => ({
  kind: "url",
  url: `https://${host}/x`,
  host,
  ...(alwaysAsk ? { alwaysAsk } : {}),
});

describe("plan mode: the permission engine (0.4)", () => {
  it("allows reads and commands in the sandbox, and denies every change without asking", async () => {
    const { approver, check } = engine("plan", "os", ["remember", "write_file"]);
    expect(await check("read_file", true, file("a.ts"))).toMatchObject({ allowed: true });
    expect(await check("explore", true)).toMatchObject({ allowed: true });
    expect(await check("bash", false, command("npm test"))).toEqual({
      allowed: true,
      by: "sandbox",
    });
    for (const [tool, target] of [
      ["write_file", file("a.ts")],
      ["edit_file", file("a.ts")],
      ["remember", { kind: "input", json: "{}" }],
      ["bash", command("rm -rf build", true)],
    ] as const) {
      expect(await check(tool, false, target), tool).toEqual({
        allowed: false,
        by: "rule",
        reason: PLAN_MODE_DENIAL,
        kind: "plan",
      });
    }
    expect(approver.requests).toEqual([]);
  });

  it("with no OS sandbox, commands are denied too", async () => {
    const { check } = engine("plan", "none");
    expect(await check("bash", false, command("ls"))).toMatchObject({ allowed: false });
  });

  it("web_fetch and MCP tools need an allow rule; a deny rule still wins", async () => {
    const plain = engine("plan");
    expect(await plain.check("web_fetch", false, url("docs.python.org"))).toMatchObject({
      allowed: false,
    });
    expect(
      await plain.check("mcp__jira__create", false, { kind: "input", json: "{}" }),
    ).toMatchObject({ allowed: false });

    const allowed = engine(
      "plan",
      "os",
      ["web_fetch(docs.python.org)", "mcp__jira__search"],
      ["read_file(secret.txt)"],
    );
    expect(await allowed.check("web_fetch", false, url("docs.python.org"))).toMatchObject({
      allowed: true,
    });
    // An unusual URL always asks in build mode; plan mode never asks, so it is denied.
    expect(await allowed.check("web_fetch", false, url("docs.python.org", true))).toMatchObject({
      allowed: false,
    });
    expect(
      await allowed.check("mcp__jira__search", false, { kind: "input", json: "{}" }),
    ).toMatchObject({ allowed: true });
    expect(await allowed.check("read_file", true, file("secret.txt"))).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/deny rule/),
    });
    expect(allowed.approver.requests).toEqual([]);
  });

  it("build mode still asks for a write", async () => {
    const { approver, check } = engine("build");
    expect(await check("write_file", false, file("a.ts"))).toMatchObject({ allowed: true });
    expect(approver.requests).toHaveLength(1);
  });

  it("commands cannot write the project in plan mode", () => {
    const plan = engine("plan").permissions.execPolicy(5_000);
    expect(plan.writePaths).not.toContain("/repo");
    expect(plan.writePaths.some((p) => p.startsWith("/repo/"))).toBe(false);
    expect(plan.denyWritePaths[0]).toBe("/repo");
    expect(plan.writePaths.length).toBeGreaterThan(0);
    const build = engine("build").permissions.execPolicy(5_000);
    expect(build.writePaths[0]).toBe("/repo");
    expect(build.denyWritePaths).not.toContain("/repo");
  });
});

// The real sandbox of this machine: the plan policy keeps the project read-only, even in a temp folder.
const found = findOsSandbox();
const osExecutor = "executor" in found ? found.executor : undefined;

describe.runIf(osExecutor !== undefined)("plan mode in the OS sandbox on this machine", () => {
  it("a command cannot write the project, but can write a temp folder", async () => {
    const executor = osExecutor as NonNullable<typeof osExecutor>;
    const root = join(base, "sandboxed");
    mkdirSync(root, { recursive: true });
    const permissions = new PermissionEngine({
      root,
      approver: new Recorder(),
      isolation: executor.isolation,
      mode: () => "plan",
    });
    const policy = permissions.execPolicy(10_000);
    const inRoot = await executor.run("echo x > planned.txt", policy);
    expect(inRoot.exitCode).not.toBe(0);
    expect(existsSync(join(root, "planned.txt"))).toBe(false);
    const temp = join(realpathSync(tmpdir()), `garuda-plan-${process.pid}.txt`);
    const inTemp = await executor.run(`echo x > ${temp} && cat ${temp} && rm ${temp}`, policy);
    expect(inTemp.exitCode, inTemp.stderr.text).toBe(0);
  });
});

async function runtimeFor(root: string, model: FakeModelClient, mode?: AgentMode) {
  return Runtime.create({
    root,
    modelId: "fake",
    model: async () => model,
    approver: new Recorder("deny"),
    store: new FileSessionStore(root),
    settings: parseSettings({ executor: "host" }),
    mcp: false,
    hooks: false,
    commands: false,
    profiles: [],
    ...(mode === undefined ? {} : { mode }),
  });
}

describe("plan mode: the runtime (0.4)", () => {
  it("adds the plan note, keeps the system prompt, and blocks a write", async () => {
    const root = join(base, "rt");
    mkdirSync(root, { recursive: true });
    const model = new FakeModelClient([
      reply([toolUse("write_file", { path: "a.ts", content: "x" }, "w1")]),
      reply([text("Plan: 1. Create a.ts.")]),
      reply([text("Done.")]),
    ]);
    const planning = await runtimeFor(root, model, "plan");
    const building = await runtimeFor(root, new FakeModelClient([]));
    expect(planning.system).toBe(building.system);
    expect(planning.extras()).toContain("plan mode");

    await planning.runTurn("Add a.ts.", signal);
    const first = model.requests[0]?.messages[0]?.content;
    expect(first?.[1]).toEqual({ type: "text", text: `<garuda_note>${PLAN_NOTE}</garuda_note>` });
    const denied = model.requests[1]?.messages.at(-1)?.content[0] as ToolResultBlock;
    expect(denied.content).toBe(`Permission denied: ${PLAN_MODE_DENIAL}`);
    expect(existsSync(join(root, "a.ts"))).toBe(false);

    // The switch applies to the next turn: no plan note then.
    planning.setMode("build");
    expect(planning.extras()).not.toContain("plan mode");
    await planning.runTurn("Go.", signal);
    const last = model.requests[2]?.messages.at(-1)?.content;
    expect(last).toEqual([{ type: "text", text: "Go." }]);
    planning.executor.shutdown();
    building.executor.shutdown();
  });
});

describe("plan mode: the chat (0.4)", () => {
  it("/plan and /build switch the mode; the status and the footer show PLAN", async () => {
    const root = join(base, "chat1");
    mkdirSync(root, { recursive: true });
    const runtime = await runtimeFor(root, new FakeModelClient([]));
    const store = new ChatStore(statusOf(runtime), { paint: noColor });
    const context = { runtime, renderer: store, sessionPath: (id: string) => id };
    await runCommand("/plan", context);
    expect(runtime.mode).toBe("plan");
    expect(statusOf(runtime).mode).toBe("plan");
    expect(store.getState().items.at(-1)?.text).toMatch(/^Plan mode: the agent reads and plans/);
    store.refreshStatus(statusOf(runtime));
    const ui = render(<App store={store} />);
    expect(ui.lastFrame()).toContain("PLAN");
    await runCommand("/build", context);
    expect(runtime.mode).toBe("build");
    store.refreshStatus(statusOf(runtime));
    await new Promise((r) => setTimeout(r, 20));
    expect(ui.lastFrame()).not.toContain("PLAN");
    ui.unmount();
    runtime.executor.shutdown();
  });

  it("the hand-off question replaces 'Allow?' in the Ink chat", async () => {
    const root = join(base, "question");
    mkdirSync(root, { recursive: true });
    const runtime = await runtimeFor(root, new FakeModelClient([]), "plan");
    const store = new ChatStore(statusOf(runtime), { paint: noColor });
    const ui = render(<App store={store} />);
    const answer = planHandoff(runtime, store);
    await new Promise((r) => setTimeout(r, 20));
    expect(ui.lastFrame()).toContain("The plan is ready.");
    expect(ui.lastFrame()).toContain("Build this plan?");
    expect(ui.lastFrame()).not.toContain("Allow?");
    store.choose("deny");
    expect(await answer).toBe("stay");
    ui.unmount();
    runtime.executor.shutdown();
  });

  it("Shift+Tab toggles the mode through the chat's handler", () => {
    const store = new ChatStore({ model: "m", sandbox: "s" }, { paint: noColor });
    let mode: AgentMode = "build";
    store.onToggleMode = () => {
      mode = mode === "plan" ? "build" : "plan";
      return { model: "m", sandbox: "s", ...(mode === "plan" ? { mode: "plan" as const } : {}) };
    };
    const key = {
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      return: false,
      escape: false,
      ctrl: false,
      meta: false,
      tab: true,
      shift: true,
      backspace: false,
      delete: false,
    };
    onKey(store, store.getState(), "", key);
    expect(mode).toBe("plan");
    expect(store.getState().status.mode).toBe("plan");
    // A plain Tab does nothing.
    onKey(store, store.getState(), "", { ...key, shift: false });
    expect(mode).toBe("plan");
  });

  it("the hand-off: build now, build later, or keep planning", async () => {
    const root = join(base, "handoff");
    mkdirSync(root, { recursive: true });
    const runtime = await runtimeFor(root, new FakeModelClient([]), "plan");
    const ask = new Recorder("deny");
    expect(await planHandoff(runtime, ask)).toBe("stay");
    expect(runtime.mode).toBe("plan");
    expect(ask.requests[0]?.question).toBe("Build this plan?");
    expect(await planHandoff(runtime, new Recorder("session"))).toBe("later");
    expect(runtime.mode).toBe("build");
    runtime.setMode("plan");
    expect(await planHandoff(runtime, new Recorder("once"))).toBe("now");
    expect(runtime.mode).toBe("build");
    runtime.executor.shutdown();
  });

  it("after a plan turn the Ink chat asks, and 'build now' runs the plan in build mode", async () => {
    const root = join(base, "handoff-chat");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    const model = new FakeModelClient([
      reply([text("Plan: 1. Change a to 2 in a.ts.")]),
      reply([text("Changed.")]),
    ]);
    const store = new ChatStore({ model: "fake", sandbox: "none" }, { paint: noColor });
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: async () => model,
      approver: store,
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      commands: false,
      profiles: [],
      mode: "plan",
      onEvent: (e) => store.event(e),
    });
    const done = runChat(
      runtime,
      store,
      (id) => id,
      () => {
        throw new Error("exit");
      },
    );
    store.editLine({ type: "insert", text: "Make a equal 2." });
    store.submitLine();
    const end = Date.now() + 3_000;
    while (store.getState().approval === undefined) {
      if (Date.now() > end) throw new Error("no hand-off question");
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(store.getState().approval?.request.question).toBe("Build this plan?");
    store.choose("once");
    while (model.remaining > 0 || store.getState().busy) {
      if (Date.now() > end) throw new Error("the build turn did not run");
      await new Promise((r) => setTimeout(r, 10));
    }
    store.editLine({ type: "insert", text: "/exit" });
    store.submitLine();
    await done;
    expect(runtime.mode).toBe("build");
    const build = model.requests[1]?.messages.at(-1)?.content;
    expect(build).toEqual([{ type: "text", text: BUILD_PROMPT }]);
    expect(store.getState().items.map((i) => i.text)).toContain(BUILD_PROMPT);
  });
});
