import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { type Hook, hooksHash, readHooks } from "../src/hooks/config.js";
import { HookRunner } from "../src/hooks/runner.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { parseRule } from "../src/permissions/rules.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../src/permissions/types.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { FileTracker } from "../src/session/fileTracker.js";
import { FileSessionStore } from "../src/session/store.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { toolContext } from "./helpers.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-hooks-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const dirs = () => {
  const d = join(base, `c${n++}`);
  const home = join(d, "home");
  const root = join(d, "root");
  mkdirSync(join(home, ".garuda"), { recursive: true });
  mkdirSync(join(root, ".garuda"), { recursive: true });
  return { home, root };
};

class Scripted implements Approver {
  readonly requests: ApprovalRequest[] = [];
  constructor(private readonly answers: ApprovalChoice[]) {}
  async ask(request: ApprovalRequest): Promise<ApprovalChoice> {
    this.requests.push(request);
    return this.answers.shift() ?? "deny";
  }
}

const hook = (
  event: Hook["event"],
  command: string,
  tools: string[] = [],
  timeoutMs = 10_000,
): Hook => ({
  event,
  source: "user",
  def: { command, tools, timeoutMs, network: false },
  rules: tools.map(parseRule),
});

function setup(hooks: Hook[], answers: ApprovalChoice[] = ["once", "once", "once"]) {
  const { root } = dirs();
  writeFileSync(join(root, "a.txt"), "hello\n");
  const approver = new Scripted(answers);
  const notes: string[] = [];
  const permissions = new PermissionEngine({ root, approver });
  const executor = new HostExecutor();
  const runner = new HookRunner({
    root,
    hooks,
    executor,
    permissions,
    notify: (t) => notes.push(t),
  });
  const registry = new ToolRegistry(defaultTools());
  const context = toolContext(root, {
    permissions,
    files: new FileTracker(),
    executor,
    hooks: runner,
  });
  let id = 0;
  const call = (name: string, input: unknown) =>
    registry.execute({ type: "tool_use", id: `h${id++}`, name, input }, context);
  return { root, approver, notes, call };
}

describe("hooks config", () => {
  it("reads hooks with rule patterns and rejects bad input", async () => {
    const { home } = dirs();
    const file = join(home, ".garuda", "hooks.json");
    writeFileSync(
      file,
      JSON.stringify({
        hooks: { preToolUse: [{ tools: ["bash(git push*)"], command: "exit 2" }] },
      }),
    );
    const { hooks } = await readHooks(file, "user");
    expect(hooks).toMatchObject([
      { event: "preToolUse", def: { command: "exit 2", timeoutMs: 30_000 } },
    ]);
    writeFileSync(file, JSON.stringify({ hooks: { onStop: [] } }));
    expect((await readHooks(file, "user")).problems).toHaveLength(1);
    writeFileSync(
      file,
      JSON.stringify({ hooks: { preToolUse: [{ tools: ["bad rule!"], command: "x" }] } }),
    );
    expect((await readHooks(file, "user")).problems[0]).toMatch(/Invalid permission rule/);
  });

  it("hashes what the hooks run", () => {
    expect(hooksHash([hook("preToolUse", "a")])).not.toBe(hooksHash([hook("preToolUse", "b")]));
  });
});

describe("preToolUse", () => {
  it("exit 2 blocks the call before the approval question; stderr tells the model why", async () => {
    const { approver, call } = setup([
      hook("preToolUse", "echo 'pushes need review' >&2; exit 2", ["bash(git push*)"]),
    ]);
    const r = await call("bash", { command: "git status && git push origin main" });
    expect(r).toEqual({ content: "Blocked by a hook: pushes need review", isError: true });
    expect(approver.requests).toEqual([]);
    expect((await call("bash", { command: "echo ok" })).content).toContain("ok");
  });

  it("fails closed: another exit code or a timeout blocks the call", async () => {
    const crash = setup([hook("preToolUse", "exit 1", ["bash"])]);
    const r = await crash.call("bash", { command: "echo hi" });
    expect(r.content).toMatch(/^Blocked by a hook: a preToolUse hook failed \(exit code 1\)/);
    expect(crash.notes[0]).toMatch(/Garuda blocked bash/);

    const slow = setup([hook("preToolUse", "sleep 5", ["bash"], 1_000)]);
    expect((await slow.call("bash", { command: "echo hi" })).content).toMatch(
      /timed out after 1000 ms/,
    );
  });

  it("gets the event data in a JSON file and variables", async () => {
    const { call } = setup([
      hook(
        "preToolUse",
        'test "$GARUDA_TOOL" = edit_file && test -f "$GARUDA_FILE" && grep -q old_string "$GARUDA_HOOK_INPUT" && exit 0; exit 2',
        ["edit_file"],
      ),
    ]);
    await call("read_file", { path: "a.txt" });
    const r = await call("edit_file", { path: "a.txt", old_string: "hello", new_string: "bye" });
    expect(r.isError).toBe(false);
  });
});

describe("postToolUse", () => {
  it("exit 2 adds feedback for the model; other failures only warn", async () => {
    const { call, notes, root } = setup([
      hook("postToolUse", "echo 'lint: missing semicolon' >&2; exit 2", ["write_file"]),
      hook("postToolUse", "exit 7", ["write_file"]),
    ]);
    const r = await call("write_file", { path: "b.txt", content: "x\n" });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("<hook_feedback>\nlint: missing semicolon\n</hook_feedback>");
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("x\n");
    expect(notes).toEqual([expect.stringMatching(/postToolUse hook failed \(exit code 7\)/)]);
  });
});

describe("project hooks need consent", () => {
  const project = (root: string, command: string) =>
    writeFileSync(
      join(root, ".garuda", "hooks.json"),
      JSON.stringify({ hooks: { preToolUse: [{ tools: ["bash"], command }] } }),
    );

  async function turn(root: string, home: string, approver: Approver) {
    const model = new FakeModelClient([
      reply([toolUse("bash", { command: "echo ran" }, "b1")]),
      reply([text("done")]),
    ]);
    const runtime = await Runtime.create({
      root,
      modelId: "claude-sonnet-5",
      model: async () => model,
      approver,
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: { home },
    });
    await runtime.runTurn("go", AbortSignal.timeout(20_000));
    return { model, runtime };
  }

  it("asks with every command; deny ignores them; remember pins them; a change asks again", async () => {
    const { home, root } = dirs();
    project(root, "echo blocked >&2; exit 2");

    const denied = new Scripted(["deny", "once"]);
    await turn(root, home, denied);
    expect(denied.requests[0]?.title).toBe("Run this project's hooks?");
    expect(denied.requests[0]?.preview).toContain("$ echo blocked >&2; exit 2");
    // Hooks ignored: the bash call reached the normal approval.
    expect(denied.requests[1]?.tool).toBe("bash");

    const remember = new Scripted(["session"]);
    const { model } = await turn(root, home, remember);
    expect(JSON.stringify(model.requests[1]?.messages.at(-1))).toContain(
      "Blocked by a hook: blocked",
    );
    const trust = JSON.parse(readFileSync(join(home, ".garuda", "trust.json"), "utf8"));
    expect(Object.keys(trust.hooks)).toEqual([root]);

    const again = new Scripted([]);
    const third = await turn(root, home, again);
    expect(again.requests).toEqual([]);
    expect(third.runtime.hookLines()).toEqual([
      "preToolUse [project] bash: echo blocked >&2; exit 2",
    ]);

    project(root, "exit 0");
    const changed = new Scripted(["deny", "deny"]);
    await turn(root, home, changed);
    expect(changed.requests[0]?.preview).toMatch(/changed since you allowed them/);
  });
});
