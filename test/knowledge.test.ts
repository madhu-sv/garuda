import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compactIfNeeded } from "../src/context/compact.js";
import { buildSystemPrompt, loadMemory, MEMORY_FILE } from "../src/context/instructions.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { ToolUseBlock } from "../src/model/types.js";
import { addUserMessage, createSession } from "../src/session/session.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { toolContext } from "./helpers.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "garuda-knowledge-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, "a.js"), "one\ntwo\nthree\n");

const registry = new ToolRegistry(defaultTools());
let id = 0;
const call = (context: ReturnType<typeof toolContext>, name: string, input: unknown) => {
  const block: ToolUseBlock = { type: "tool_use", id: `k${id++}`, name, input };
  return registry.execute(block, context);
};

describe("read deduplication", () => {
  it("does not send the same lines of an unchanged file twice", async () => {
    const context = toolContext(root);
    expect((await call(context, "read_file", { path: "a.js" })).content).toContain("     2\ttwo");
    const again = await call(context, "read_file", { path: "a.js" });
    expect(again.content).toMatch(/unchanged since your last read_file/);
    // Other lines are a new read.
    expect((await call(context, "read_file", { path: "a.js", offset: 2 })).content).toContain(
      "     2\ttwo",
    );
  });

  it("sends the file again after it changes", async () => {
    const context = toolContext(root);
    await call(context, "read_file", { path: "a.js" });
    writeFileSync(join(root, "a.js"), "one\nTWO\nthree\n");
    expect((await call(context, "read_file", { path: "a.js" })).content).toContain("     2\tTWO");
  });

  it("sends the file again after compaction, because old outputs may be gone", async () => {
    const session = createSession(root, "s");
    const context = toolContext(root, { files: session.files });
    await call(context, "read_file", { path: "a.js" });
    addUserMessage(session, "task");
    for (let i = 0; i < 5; i++) {
      session.messages.push({
        role: "assistant",
        content: [toolUse("glob", { pattern: "*" }, `g${i}`)],
      });
      session.messages.push({
        role: "user",
        content: [
          { type: "tool_result", toolUseId: `g${i}`, content: "x".repeat(3_000), isError: false },
        ],
      });
    }
    session.contextTokens = 9_000;
    await compactIfNeeded(
      session,
      new FakeModelClient([reply([text("s")])]),
      { contextWindow: 10_000 },
      new AbortController().signal,
    );
    expect((await call(context, "read_file", { path: "a.js" })).content).toContain("     1\tone");
  });
});

describe("project memory", () => {
  it("remember adds one line per fact, with no duplicates and no secrets", async () => {
    const context = toolContext(root);
    const first = await call(context, "remember", { fact: "Tests run with: node --test" });
    expect(first.content).toMatch(/Saved to \.garuda\/memory\.md/);
    const dup = await call(context, "remember", { fact: "tests run with:   node --test" });
    expect(dup.content).toMatch(/already has this fact/);
    await call(context, "remember", {
      fact: "Deploy key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
    });

    const file = readFileSync(join(root, MEMORY_FILE), "utf8");
    expect(file).toContain("# Garuda project memory");
    expect(file.match(/^- /gm)).toHaveLength(2);
    expect(file).not.toContain("sk-ant");
  });

  it("asks for approval, and shows the fact", async () => {
    const approvals: string[] = [];
    const { AutoApprover } = await import("../src/permissions/autoApprover.js");
    const { PermissionEngine } = await import("../src/permissions/engine.js");
    const approver = new AutoApprover((r) => {
      approvals.push(r.preview);
      return "deny";
    });
    const context = toolContext(root, { permissions: new PermissionEngine({ root, approver }) });
    const r = await call(context, "remember", { fact: "Layout: code in src/" });
    expect(r.isError).toBe(true);
    expect(approvals).toEqual(["+ - Layout: code in src/"]);
  });

  it("loads into the system prompt of the next session, after GARUDA.md", async () => {
    const memory = await loadMemory(root);
    expect(memory).toContain("- Tests run with: node --test");
    const prompt = buildSystemPrompt(root, "Use pnpm.", memory);
    expect(prompt.indexOf("# Project instructions")).toBeLessThan(
      prompt.indexOf("# Project memory"),
    );
    expect(prompt).toContain("They can be out of date");
    expect(await loadMemory(join(root, "missing"))).toBeUndefined();
  });

  it("refuses to grow past the size limit", async () => {
    const dir = join(root, "full");
    mkdirSync(join(dir, ".garuda"), { recursive: true });
    writeFileSync(join(dir, MEMORY_FILE), `${"- x\n".repeat(2_000)}`);
    const r = await call(toolContext(dir), "remember", { fact: "One more fact" });
    expect(r.content).toMatch(/memory is full/);
  });
});
