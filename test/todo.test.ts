import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { PlainRenderer, summariseCall, summariseResult } from "../src/cli/renderer.js";
import { buildSystemPrompt } from "../src/context/instructions.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { ToolResultBlock } from "../src/model/types.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import { FileSessionStore } from "../src/session/store.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { allowAll, sink, toolContext } from "./helpers.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-todo-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const PLAN = {
  todos: [
    { content: "Read the failing test", status: "completed" },
    { content: "Fix the rounding", status: "in_progress" },
    { content: "Run the tests", status: "pending" },
  ],
};

const registry = new ToolRegistry(defaultTools({ todo: true }));
const run = (input: unknown) =>
  registry.execute(
    toolUse("todo_write", input, "t1"),
    toolContext(base, { permissions: allowAll(base) }),
  );

describe("todo_write (0.4)", () => {
  it("shows the list back, with marks and a count", async () => {
    expect(await run(PLAN)).toEqual({
      content:
        "Todo list (1 of 3 done):\n[x] Read the failing test\n[>] Fix the rounding\n[ ] Run the tests",
      isError: false,
    });
    expect((await run({ todos: [] })).content).toBe("The todo list is empty.");
  });

  it("refuses two steps in progress, bad statuses, empty steps and long lists", async () => {
    const two = await run({
      todos: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ],
    });
    expect(two).toMatchObject({ isError: true });
    expect(two.content).toMatch(/Mark only one step in_progress/);
    expect((await run({ todos: [{ content: "a", status: "doing" }] })).isError).toBe(true);
    expect((await run({ todos: [{ content: "  ", status: "pending" }] })).isError).toBe(true);
    const many = Array.from({ length: 31 }, (_, i) => ({ content: `s${i}`, status: "pending" }));
    expect((await run({ todos: many })).isError).toBe(true);
  });

  it("is off by default; the setting adds the tool and its prompt lines", async () => {
    expect(defaultTools().some((t) => t.name === "todo_write")).toBe(false);
    expect(buildSystemPrompt("/r", undefined)).not.toContain("todo_write");
    expect(buildSystemPrompt("/r", undefined, undefined, { todo: true })).toContain(
      "keep a plan with todo_write",
    );
    expect(parseSettings({ todo: { enabled: true } }).todo).toEqual({ enabled: true });
    expect(() => parseSettings({ todo: { enable: true } })).toThrow(/todo/);
  });

  it("runs in a turn with no approval, and the chat and plain output show the checklist", async () => {
    const root = join(base, "turn");
    const model = new FakeModelClient([
      reply([toolUse("todo_write", PLAN, "t1")]),
      reply([text("Planned.")]),
    ]);
    const store = new ChatStore({ model: "fake", sandbox: "none" }, { paint: noColor });
    const err = sink();
    const plain = new PlainRenderer({ out: sink().stream, err: err.stream }, false);
    const runtime = await Runtime.create({
      root: realpathSync(mkdtempSync(`${root}-`)),
      modelId: "fake",
      model: async () => model,
      approver: new AutoApprover("deny"),
      store: new FileSessionStore(base),
      settings: parseSettings({ todo: { enabled: true } }),
      mcp: false,
      hooks: false,
      commands: false,
      profiles: [],
      onEvent: (e) => {
        store.event(e);
        plain.event(e);
      },
    });
    expect(runtime.system).toContain("keep a plan with todo_write");
    await runtime.runTurn("Fix the bug.", new AbortController().signal);
    const result = model.requests[1]?.messages.at(-1)?.content[0] as ToolResultBlock;
    expect(result.isError).toBe(false);

    const checklist = "    ✔ Read the failing test\n    ▶ Fix the rounding\n    ○ Run the tests";
    expect(store.getState().items.map((i) => i.text)).toContain(
      `● todo_write 3 step(s)\n  ⎿ 1 of 3 done\n${checklist}`,
    );
    expect(err.text()).toContain(`● todo_write 3 step(s)\n  ⎿ 1 of 3 done\n${checklist}\n`);
    runtime.executor.shutdown();
  });

  it("summaries for other results stay the same", () => {
    const call = toolUse("todo_write", { todos: [] }, "t1");
    expect(summariseCall(call)).toBe("0 step(s)");
    expect(summariseResult(call, { content: "The todo list is empty.", isError: false })).toBe(
      "The todo list is empty.",
    );
  });
});
