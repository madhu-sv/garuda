import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChild } from "../src/agents/child.js";
import { BudgetExhausted, TokenBudget } from "../src/loop/budget.js";
import { callModelWithRetry } from "../src/loop/callModel.js";
import { runAgent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { totalTokens } from "../src/model/pricing.js";
import type { ModelClient, ModelRequest, Usage } from "../src/model/types.js";
import { addUserMessage, createSession } from "../src/session/session.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { allowAll, toolContext, upperTool } from "./helpers.js";

/** One token budget for the agent tree (0.17, review T9; docs/lld/bounded-changes.md). */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-budget-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const signal = new AbortController().signal;
const usage = (inputTokens: number, outputTokens = 10): Usage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

describe("TokenBudget", () => {
  it("a reported usage settles the reservation; the rest returns", () => {
    const budget = new TokenBudget(1_000);
    const hold = budget.reserve(300);
    expect(hold).toBeDefined();
    expect(budget.left).toBe(700);
    budget.settle(hold as NonNullable<typeof hold>, 120);
    expect(budget).toMatchObject({ left: 880, spent: 120 });
    // A second settle of the same reservation changes nothing.
    budget.settle(hold as NonNullable<typeof hold>, 0);
    expect(budget.spent).toBe(120);
  });

  it("no reported usage (an error, a cancel): the whole reservation stays spent", () => {
    const budget = new TokenBudget(1_000);
    const hold = budget.reserve(300);
    budget.settle(hold as NonNullable<typeof hold>);
    expect(budget).toMatchObject({ left: 700, spent: 300 });
  });

  it("a reservation that does not fit is refused", () => {
    const budget = new TokenBudget(100);
    expect(budget.reserve(101)).toBeUndefined();
    expect(budget.reserve(100)).toBeDefined();
    expect(budget.reserve(1)).toBeUndefined();
  });

  it("a child has its own cap, inside what the parent has left, and never takes the floor", () => {
    const parent = new TokenBudget(1_000);
    const child = parent.child(5_000);
    parent.setFloor(400);
    expect(child.reserve(700)).toBeUndefined();
    const hold = child.reserve(600);
    expect(hold).toBeDefined();
    expect(parent.left).toBe(400);
    // The parent's own call may use its floor.
    expect(parent.reserve(400)).toBeDefined();
    const small = parent.child(50);
    parent.setFloor(0);
    expect(small.reserve(60)).toBeUndefined();
  });
});

describe("model calls under the budget", () => {
  const request: ModelRequest = { system: "s", messages: [], tools: [], maxTokens: 10 };

  it("a failed call with no usage keeps its reservation; no room means no request", async () => {
    const failing: ModelClient = {
      // biome-ignore lint/correctness/useYield: the stream fails before its first event.
      async *stream() {
        throw new Error("400 bad request");
      },
    };
    const budget = new TokenBudget(1_000);
    await expect(
      callModelWithRetry(failing, request, signal, () => {}, [], { budget, tokens: 300 }),
    ).rejects.toThrow("400");
    expect(budget.spent).toBe(300);

    const model = new FakeModelClient([reply([text("ok")])]);
    await expect(
      callModelWithRetry(model, request, signal, () => {}, [], { budget, tokens: 800 }),
    ).rejects.toThrow(BudgetExhausted);
    expect(model.requests).toHaveLength(0);
  });

  it("a cancelled call keeps its reservation", async () => {
    const controller = new AbortController();
    controller.abort();
    const budget = new TokenBudget(1_000);
    const model = new FakeModelClient([reply([text("ok")])]);
    await expect(
      callModelWithRetry(model, request, controller.signal, () => {}, [], {
        budget,
        tokens: 250,
      }),
    ).rejects.toThrow();
    expect(budget.spent).toBe(250);
  });
});

function looping(count: number) {
  return new FakeModelClient(
    Array.from({ length: count }, (_, i) =>
      reply([toolUse("upper", { text: `t${i}` })], undefined, usage(50)),
    ),
  );
}

async function child(budget: TokenBudget | undefined) {
  const session = createSession(base, "c", undefined);
  addUserMessage(session, "go");
  const result = await runAgent(session, {
    model: looping(20),
    tools: new ToolRegistry([upperTool()]),
    system: "s",
    permissions: allowAll(base),
    maxSteps: 10,
    maxTokens: 100,
    tokenBudget: 1_000,
    ...(budget === undefined ? {} : { budget: budget.child(1_000) }),
  });
  return { result, used: totalTokens(session.usage) };
}

describe("parallel children share one budget", () => {
  it("three children at once stay inside the parent's cap", async () => {
    // Negative control: each child alone has 1 000 tokens, so together they use 3 × 600.
    const alone = await Promise.all([child(undefined), child(undefined), child(undefined)]);
    expect(alone.reduce((sum, c) => sum + c.used, 0)).toBeGreaterThan(600);

    const shared = new TokenBudget(600);
    const runs = await Promise.all([child(shared), child(shared), child(shared)]);
    expect(runs.reduce((sum, c) => sum + c.used, 0)).toBeLessThanOrEqual(600);
    expect(shared.spent).toBeLessThanOrEqual(600);
    expect(runs.some((r) => r.result.stopReason === "token_budget")).toBe(true);
  });

  it("a subagent run reserves in the turn's budget (ToolContext.budget)", async () => {
    const shared = new TokenBudget(100_000);
    const model = new FakeModelClient([reply([text("found it")], undefined, usage(40))]);
    const result = await runChild(
      {
        id: "child",
        system: "s",
        prompt: "look",
        tools: new ToolRegistry(),
        model: { spec: "fake", contextWindow: 100_000, client: async () => model },
        permissions: allowAll(base),
        limits: { maxSteps: 3, tokenBudget: 10_000 },
        maxTokens: 20,
      },
      toolContext(base, { budget: shared }),
    );
    expect(result.answer).toBe("found it");
    expect(shared.spent).toBe(50);
  });

  it("the parent still gets its final answer after its children used the rest", async () => {
    const parent = new TokenBudget(1_000);
    parent.setFloor(300);
    const kid = parent.child(10_000);
    while (kid.reserve(100) !== undefined) {}
    expect(parent.left).toBe(300);
    parent.setFloor(0);
    expect(parent.reserve(300)).toBeDefined();
  });
});
