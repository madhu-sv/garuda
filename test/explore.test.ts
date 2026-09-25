import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXPLORE_SYSTEM } from "../src/agents/explore.js";
import { Runtime } from "../src/app/runtime.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { summariseCall, summariseResult } from "../src/cli/renderer.js";
import type { AgentEvent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { ModelInfo } from "../src/model/pricing.js";
import type { ToolResultBlock } from "../src/model/types.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { ToolResultsRecord } from "../src/session/records.js";
import { resumeSession } from "../src/session/resume.js";
import { FileSessionStore } from "../src/session/store.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-explore-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function repo(): string {
  const root = join(base, `r${n++}`);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "coupon.ts"), "export function applyCoupon() {}\n");
  writeFileSync(
    join(root, "src", "cart.ts"),
    'import { applyCoupon } from "./coupon";\napplyCoupon();\n',
  );
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  return root;
}

const PRICE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const INFO: ModelInfo = { contextWindow: 200_000, price: PRICE };
const QUESTION = "Where is applyCoupon defined and where is it used?";

async function runtimeFor(
  root: string,
  parent: FakeModelClient,
  child: FakeModelClient | undefined,
  settings: unknown = {},
  onEvent?: (e: AgentEvent) => void,
) {
  return Runtime.create({
    root,
    modelId: "fake-main",
    model: async () => parent,
    modelInfo: INFO,
    ...(child === undefined
      ? {}
      : { subagentModel: { spec: "fake-small", model: async () => child, info: INFO } }),
    approver: new AutoApprover("once"),
    store: new FileSessionStore(root),
    settings: parseSettings(settings),
    mcp: false,
    hooks: false,
    profiles: [],
    ...(onEvent === undefined ? {} : { onEvent }),
  });
}

const resultOf = (parent: FakeModelClient, step: number): ToolResultBlock | undefined =>
  parent.requests[step]?.messages
    .at(-1)
    ?.content.find((b): b is ToolResultBlock => b.type === "tool_result");

describe("explore subagent (0.3)", () => {
  it("answers in its own context with read-only tools, and its usage counts for the session", async () => {
    const root = repo();
    const parent = new FakeModelClient([
      reply([toolUse("explore", { question: QUESTION }, "x1")]),
      reply([text("It is in src/coupon.ts.")]),
    ]);
    const child = new FakeModelClient([
      reply([toolUse("grep", { pattern: "applyCoupon" }, "c1")]),
      // Tools that the child does not have: they fail, and nothing is written.
      reply([
        toolUse("write_file", { path: "hacked.txt", content: "x" }, "c2"),
        toolUse("explore", { question: "Recurse into another subagent?" }, "c3"),
        toolUse("read_file", { path: ".env" }, "c4"),
      ]),
      reply([text("Defined in src/coupon.ts:1; used in src/cart.ts:2.")]),
    ]);
    const events: AgentEvent[] = [];
    const runtime = await runtimeFor(root, parent, child, {}, (e) => events.push(e));
    const result = await runtime.runTurn("Find applyCoupon.", new AbortController().signal);
    expect(result.stopReason).toBe("done");

    // The child saw only its own prompt and the read-only tools.
    expect(child.requests[0]?.system).toBe(EXPLORE_SYSTEM);
    expect(child.requests[0]?.messages).toHaveLength(1);
    expect(child.requests[0]?.tools.map((t) => t.name)).toEqual(["glob", "grep", "read_file"]);
    const childResults = child.requests[2]?.messages.at(-1)?.content as ToolResultBlock[];
    expect(childResults.map((r) => r.content.slice(0, 40))).toEqual([
      'Error: unknown tool "write_file".',
      'Error: unknown tool "explore".',
      expect.stringMatching(/^Permission denied: \.env is a sensitive/),
    ]);
    expect(existsSync(join(root, "hacked.txt"))).toBe(false);

    // The main agent got only the answer, with a trailer of the search.
    const answer = resultOf(parent, 1);
    expect(answer?.isError).toBe(false);
    expect(answer?.content).toMatch(/^Defined in src\/coupon\.ts:1; used in src\/cart\.ts:2\./);
    expect(answer?.content).toMatch(/\[explore: 3 steps · 0\.0k tokens\]/);
    expect(answer?.content).toContain("[searched: grep /applyCoupon/; write_file");

    // Live progress for the chat.
    expect(
      events.filter((e) => e.type === "tool_progress").map((e) => (e as { text: string }).text),
    ).toEqual([
      "step 1 · grep /applyCoupon/",
      'step 2 · write_file {"path":"hacked.txt","content":"x"}',
      'step 3 · explore {"question":"Recurse into another subagent?"}',
      "step 4 · read_file .env",
    ]);

    // Usage: 2 parent calls and 3 child calls of 15 tokens each; cost with a price of $1/M.
    const session = runtime.session;
    expect(session?.usage.inputTokens).toBe(50);
    expect(session?.usage.outputTokens).toBe(25);
    expect(session?.costUsd).toBeCloseTo(75 / 1e6, 12);
    expect(result.usage.inputTokens).toBe(50);

    // The child run has its own file with the parent session; the parent records the report.
    const store = new FileSessionStore(root);
    const id = session?.id ?? "";
    const childFile = store.childPath(id, "explore-x1");
    expect(existsSync(childFile)).toBe(true);
    expect(await store.latest()).toBe(id);
    const records = await store.read(id);
    const meta = records.find((r): r is ToolResultsRecord => r.type === "tool_results")?.calls[0];
    expect(meta?.subagent).toMatchObject({
      sessionId: "explore-x1",
      model: "fake-small",
      steps: 3,
      stopReason: "done",
    });

    // Resume counts the child's usage too.
    const resumed = await resumeSession({
      store,
      root,
      start: {
        root,
        version: "test",
        model: "fake-main",
        executor: "host",
        isolation: "none",
        limits: runtime.limits,
      },
      sessionId: id,
    });
    expect(resumed.usage.inputTokens).toBe(50);
    expect(resumed.costUsd).toBeCloseTo(75 / 1e6, 12);
    runtime.executor.shutdown();
  });

  it("uses the main model by default, and still answers when it hits its step limit", async () => {
    const root = repo();
    // One client for both: the main agent, then the child (2 steps and a wrap-up), then the main agent.
    const model = new FakeModelClient([
      reply([toolUse("explore", { question: QUESTION }, "x1")]),
      reply([toolUse("glob", { pattern: "src/**" }, "c1")]),
      reply([toolUse("grep", { pattern: "applyCoupon" }, "c2")]),
      (request) => {
        // The wrap-up asks for an answer with no more tool calls.
        const last = request.messages.at(-1)?.content.at(-1);
        expect(last).toMatchObject({
          type: "text",
          text: expect.stringMatching(/Do not call tools/),
        });
        return reply([text("Partial: src/coupon.ts defines it.")]);
      },
      reply([text("Done.")]),
    ]);
    const runtime = await runtimeFor(root, model, undefined, { subagents: { maxSteps: 2 } });
    await runtime.runTurn("Find applyCoupon.", new AbortController().signal);
    const answer = model.requests[4]?.messages.at(-1)?.content[0] as ToolResultBlock;
    expect(answer.content).toMatch(/^Partial: src\/coupon\.ts defines it\./);
    expect(answer.content).toMatch(/\[explore: 3 steps · .* · stopped early \(max_steps\)\]/);
    expect(runtime.extras()).toContain("explore");
    runtime.executor.shutdown();
  });

  it("can be turned off, and a deny rule blocks it", async () => {
    const root = repo();
    const off = await runtimeFor(root, new FakeModelClient([]), undefined, {
      subagents: { enabled: false },
    });
    expect(off.system).not.toContain("call explore");
    expect(off.extras()).not.toContain("explore");
    expect(off.exploreModel).toBeUndefined();
    off.executor.shutdown();

    const parent = new FakeModelClient([
      reply([toolUse("explore", { question: QUESTION }, "x1")]),
      reply([text("ok")]),
    ]);
    const denied = await runtimeFor(root, parent, new FakeModelClient([]), {
      permissions: { deny: ["explore"] },
    });
    expect(denied.system).toContain("call explore");
    expect(denied.extras()).toContain("explore: fake-small");
    await denied.runTurn("Find applyCoupon.", new AbortController().signal);
    expect(resultOf(parent, 1)?.content).toMatch(/^Permission denied: A deny rule/);
    denied.executor.shutdown();
  });

  it("rejects a question that is too short", async () => {
    const root = repo();
    const parent = new FakeModelClient([
      reply([toolUse("explore", { question: "where?" }, "x1")]),
      reply([text("ok")]),
    ]);
    const runtime = await runtimeFor(root, parent, new FakeModelClient([]));
    await runtime.runTurn("Find it.", new AbortController().signal);
    expect(resultOf(parent, 1)?.content).toMatch(/^Error: invalid input for explore/);
    runtime.executor.shutdown();
  });

  it("the chat shows one live line per explore call, then a summary", () => {
    const store = new ChatStore({ model: "fake", sandbox: "none" }, { paint: noColor });
    const call = toolUse("explore", { question: QUESTION }, "x1");
    store.begin("task");
    store.event({ type: "tool_call", call });
    store.event({ type: "tool_progress", call, text: "step 2 · grep /applyCoupon/" });
    expect(store.getState().running).toEqual([
      { id: "x1", line: `explore ${QUESTION} · step 2 · grep /applyCoupon/` },
    ]);
    const content =
      "Defined in a.ts:1.\nUsed in b.ts:2.\n\n[explore: 3 steps · 1.2k tokens]\n[searched: grep /x/]";
    expect(summariseCall(call)).toBe(QUESTION);
    expect(summariseResult(call, { content, isError: false })).toBe(
      "answer (2 line(s)) · 3 steps · 1.2k tokens",
    );
  });

  it("settings: subagents takes enabled and limits, and refuses unknown keys", () => {
    expect(
      parseSettings({ subagents: { enabled: false, maxSteps: 5, tokenBudget: 50_000 } }).subagents,
    ).toEqual({
      enabled: false,
      maxSteps: 5,
      tokenBudget: 50_000,
    });
    expect(() => parseSettings({ subagents: { model: "x" } })).toThrow(/subagents/);
    expect(() => parseSettings({ subagents: { tokenBudget: 10 } })).toThrow(/tokenBudget/);
  });
});
