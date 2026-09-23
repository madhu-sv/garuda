import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type AgentEvent, runAgent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { ModelRequest, ToolResultBlock } from "../src/model/types.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { loadSettings } from "../src/permissions/settings.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { addUserMessage, createSession } from "../src/session/session.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";

/** A tiny Node project with one failing test: add() subtracts. */
function makeBuggyRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "garuda-m3-"));
  const files: Record<string, string> = {
    "package.json": '{ "name": "sample", "type": "module" }\n',
    "src/math.js": "export function add(a, b) {\n  return a - b;\n}\n",
    "test/math.test.js": [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import { add } from "../src/math.js";',
      "",
      'test("add", () => {',
      "  assert.equal(add(2, 3), 5);",
      "});",
      "",
    ].join("\n"),
    ".garuda/settings.json": JSON.stringify({ permissions: { deny: ["bash(rm -rf*)"] } }),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function lastResult(request: ModelRequest): ToolResultBlock {
  const block = request.messages.at(-1)?.content[0];
  if (block?.type !== "tool_result") throw new Error("expected a tool_result");
  return block;
}

async function setup(steps: ConstructorParameters<typeof FakeModelClient>[0]) {
  const root = makeBuggyRepo();
  roots.push(root);
  const approver = new AutoApprover("once");
  const executor = new HostExecutor();
  const permissions = new PermissionEngine({
    root,
    approver,
    settings: await loadSettings(root),
    isolation: executor.isolation,
  });
  const model = new FakeModelClient(steps);
  const session = createSession(root);
  const events: AgentEvent[] = [];
  const run = (prompt: string) => {
    addUserMessage(session, prompt);
    return runAgent(session, {
      model,
      tools: new ToolRegistry(defaultTools()),
      system: "test",
      permissions,
      executor,
      onEvent: (e) => events.push(e),
    });
  };
  return { root, approver, model, events, run };
}

describe("M3 acceptance", () => {
  it("fixes a failing test; every write and command asks first", async () => {
    const t = await setup([
      reply([toolUse("bash", { command: "node --test" }, "b1")]),
      (request) => {
        const result = lastResult(request);
        expect(result.content).toMatch(/^Exit code: 1/);
        expect(result.content).toMatch(/fail 1/);
        return reply([toolUse("read_file", { path: "src/math.js" }, "r1")]);
      },
      (request) => {
        expect(lastResult(request).content).toContain("     2\t  return a - b;");
        return reply([
          text("add() subtracts. I will fix it."),
          toolUse(
            "edit_file",
            { path: "src/math.js", old_string: "return a - b;", new_string: "return a + b;" },
            "e1",
          ),
        ]);
      },
      (request) => {
        expect(lastResult(request)).toMatchObject({
          content: "Edited src/math.js.",
          isError: false,
        });
        return reply([toolUse("bash", { command: "node --test" }, "b2")]);
      },
      (request) => {
        const result = lastResult(request);
        expect(result.content).toMatch(/^Exit code: 0/);
        expect(result.content).toMatch(/pass 1/);
        return reply([text("Fixed: add() now returns a + b. The test passes.")]);
      },
    ]);

    const result = await t.run("The test fails. Fix it.");

    expect(result).toMatchObject({ stopReason: "done", steps: 5 });
    expect(t.model.remaining).toBe(0);
    expect(readFileSync(join(t.root, "src/math.js"), "utf8")).toContain("return a + b;");
    // Two commands and one edit. Each asked first. The read did not ask.
    expect(t.approver.requests.map((r) => r.tool)).toEqual(["bash", "edit_file", "bash"]);
    expect(t.approver.requests[1]?.preview).toContain("+  return a + b;");
    const errors = t.events.filter((e) => e.type === "tool_result" && e.outcome.isError);
    expect(errors).toEqual([]);
  });

  it("a deny rule blocks rm -rf, with no question and no effect", async () => {
    const t = await setup([
      reply([toolUse("bash", { command: "rm -rf src" }, "b1")]),
      (request) => {
        const result = lastResult(request);
        expect(result.isError).toBe(true);
        expect(result.content).toContain("A deny rule blocks this call: bash(rm -rf*).");
        return reply([text("A rule blocks that command.")]);
      },
    ]);

    await t.run("Delete the src folder.");

    expect(existsSync(join(t.root, "src/math.js"))).toBe(true);
    expect(t.approver.requests).toEqual([]);
  });
});
