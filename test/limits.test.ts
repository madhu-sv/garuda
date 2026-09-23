import { describe, expect, it } from "vitest";
import { stopMessage, usageLine } from "../src/cli/report.js";
import { runAgent, signature } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { costOf, lookupModel } from "../src/model/pricing.js";
import type { Usage } from "../src/model/types.js";
import { addUserMessage, createSession } from "../src/session/session.js";
import { MemoryJournal } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { allowAll, upperTool } from "./helpers.js";

const usage = (inputTokens: number, outputTokens = 10): Usage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

function setup() {
  const journal = new MemoryJournal();
  const session = createSession("/tmp/project", "s1", journal);
  addUserMessage(session, "go");
  return { session, journal };
}

const deps = (model: FakeModelClient) => ({
  model,
  tools: new ToolRegistry([upperTool()]),
  system: "s",
  permissions: allowAll(),
});

describe("step limit and token budget (F6)", () => {
  it("stops at maxSteps and records the reason", async () => {
    const steps = Array.from({ length: 10 }, (_, i) =>
      reply([toolUse("upper", { text: `t${i}` })]),
    );
    const { session, journal } = setup();
    const result = await runAgent(session, { ...deps(new FakeModelClient(steps)), maxSteps: 4 });
    expect(result).toMatchObject({ stopReason: "max_steps", steps: 4 });
    expect(journal.records.at(-1)).toMatchObject({
      type: "end",
      stopReason: "max_steps",
      steps: 4,
    });
  });

  it("stops before the next model call when the session passes the token budget", async () => {
    const steps = Array.from({ length: 10 }, (_, i) =>
      reply([toolUse("upper", { text: `t${i}` })], undefined, usage(400, 100)),
    );
    const { session } = setup();
    const model = new FakeModelClient(steps);
    const result = await runAgent(session, { ...deps(model), tokenBudget: 1_200 });
    // 500 tokens per step: after 3 steps the session has 1 500 ≥ 1 200.
    expect(result).toMatchObject({ stopReason: "token_budget", steps: 3 });
    expect(model.requests).toHaveLength(3);
  });

  it("the budget counts earlier runs of the same session", async () => {
    const { session } = setup();
    session.usage = usage(5_000);
    const model = new FakeModelClient([reply([text("hi")])]);
    const result = await runAgent(session, { ...deps(model), tokenBudget: 1_000 });
    expect(result).toMatchObject({ stopReason: "token_budget", steps: 0 });
    expect(model.requests).toHaveLength(0);
  });
});

describe("repeated tool calls (F7)", () => {
  it("stops after three identical calls in a row", async () => {
    const same = () => reply([toolUse("upper", { text: "again" })]);
    const { session } = setup();
    const model = new FakeModelClient([same(), same(), same(), same()]);
    const result = await runAgent(session, deps(model));
    expect(result).toMatchObject({ stopReason: "repeated_calls", steps: 3 });
    expect(model.remaining).toBe(1);
  });

  it("does not stop when the calls differ", async () => {
    const { session } = setup();
    const model = new FakeModelClient([
      reply([toolUse("upper", { text: "a" })]),
      reply([toolUse("upper", { text: "a" })]),
      reply([toolUse("upper", { text: "b" })]),
      reply([toolUse("upper", { text: "a" })]),
      reply([text("done")]),
    ]);
    expect((await runAgent(session, deps(model))).stopReason).toBe("done");
  });

  it("the signature ignores key order", () => {
    const a = signature({
      type: "tool_use",
      id: "1",
      name: "t",
      input: { x: 1, y: [1, { b: 2, a: 1 }] },
    });
    const b = signature({
      type: "tool_use",
      id: "2",
      name: "t",
      input: { y: [1, { a: 1, b: 2 }], x: 1 },
    });
    expect(a).toBe(b);
  });
});

describe("pricing and the usage line (F22)", () => {
  it("finds the longest model prefix", () => {
    expect(lookupModel("claude-opus-5-5").price?.input).toBe(4);
    expect(lookupModel("claude-opus-5-20260101").price?.input).toBe(5);
    expect(lookupModel("claude-haiku-4-5-20251001").contextWindow).toBe(200_000);
    expect(lookupModel("some-other-model")).toEqual({ contextWindow: 200_000 });
  });

  it("computes cost from all four token kinds", () => {
    const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    const cost = costOf(
      {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 0,
      },
      price,
    );
    expect(cost).toBeCloseTo(3 + 1.5 + 0.3);
  });

  it("prints steps, tokens, cost and context share", () => {
    const { session } = setup();
    session.usage = usage(20_000, 1_000);
    session.costUsd = 0.1234;
    session.contextTokens = 50_000;
    const line = usageLine(
      { stopReason: "done", steps: 3, usage: { ...usage(2_000, 500), cacheReadTokens: 10_000 } },
      session,
      0.042,
      200_000,
    );
    expect(line).toBe(
      "done · 3 step(s) · 12.0k in (10.0k cached) / 500 out · $0.04 · context 25% of 200.0k · session 21.0k tokens, $0.12",
    );
    expect(stopMessage("done", { maxSteps: 50, tokenBudget: 1 })).toBeUndefined();
    expect(stopMessage("max_steps", { maxSteps: 50, tokenBudget: 1 })).toContain("step limit (50)");
  });
});
