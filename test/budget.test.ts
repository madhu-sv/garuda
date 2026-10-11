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

describe("budget gaps from the review of 31aab17", () => {
  function childRun(
    model: FakeModelClient,
    system: string,
    tokenBudget: number,
    tools = new ToolRegistry(),
  ) {
    return {
      id: "kid",
      system,
      prompt: "look",
      tools,
      model: { spec: "fake", contextWindow: 1_000_000, client: async () => model },
      permissions: allowAll(base),
      limits: { maxSteps: 1, tokenBudget },
      maxTokens: 20,
    };
  }

  it("P1: a child's wrap-up reserves the whole request, also with zero completed steps", async () => {
    const shared = new TokenBudget(1_000);
    const model = new FakeModelClient([
      reply([text("first")], undefined, usage(2_000, 10)),
      reply([text("wrap-up")], undefined, usage(2_000, 10)),
    ]);
    const result = await runChild(
      childRun(model, "x".repeat(8_000), 1_000),
      toolContext(base, { budget: shared }),
    );
    expect(model.requests).toHaveLength(0);
    expect(result.answer).toMatch(/no room in its token budget/);
    expect(shared.spent).toBe(0);
  });

  it("P1: a child's wrap-up after a large tool result does not fit, and does not start", async () => {
    const shared = new TokenBudget(1_500);
    const model = new FakeModelClient([
      reply([toolUse("upper", { text: "a".repeat(4_000) })], undefined, usage(300, 20)),
      reply([text("wrap-up")], undefined, usage(300, 20)),
    ]);
    const result = await runChild(
      childRun(model, "s", 1_500, new ToolRegistry([upperTool()])),
      toolContext(base, { budget: shared }),
    );
    expect(model.requests).toHaveLength(1);
    expect(result.answer).toMatch(/no room in its token budget/);
    expect(shared.spent).toBeLessThanOrEqual(1_500);
  });

  it("P1: an OpenAI-compatible HTTP retry reserves again; no room, no second request", async () => {
    const { OpenAICompatibleClient } = await import("../src/model/openaiCompatible.js");
    let posts = 0;
    const client = new OpenAICompatibleClient({
      provider: "box",
      baseUrl: "http://127.0.0.1:9/v1",
      model: "m",
      retryDelaysMs: [0, 0],
      fetch: (async () => {
        posts++;
        return new Response("busy", { status: 503 });
      }) as typeof fetch,
    });
    const budget = new TokenBudget(300);
    const request: ModelRequest = { system: "s", messages: [], tools: [], maxTokens: 10 };
    await expect(
      callModelWithRetry(client, request, signal, () => {}, [], { budget, tokens: 300 }),
    ).rejects.toThrow(BudgetExhausted);
    expect(posts).toBe(1);
    expect(budget.spent).toBe(300);
  });

  it("P1: a batch job's switch to the normal API reserves again; the cancelled request stays spent", async () => {
    const { DeadlineClient } = await import("../src/model/deadline.js");
    const waiting: ModelClient = {
      async *stream(_request, options) {
        await new Promise((_resolve, reject) =>
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason)),
        );
        yield* [];
      },
    };
    const request: ModelRequest = { system: "s", messages: [], tools: [], maxTokens: 10 };
    for (const [total, fallbackRequests, spent] of [
      [300, 0, 300],
      [700, 1, 340],
    ] as const) {
      const fallback = new FakeModelClient([reply([text("ok")], undefined, usage(30, 10))]);
      const client = new DeadlineClient(waiting, async () => fallback, new Date(Date.now() + 20));
      const budget = new TokenBudget(total);
      const call = callModelWithRetry(client, request, signal, () => {}, [], {
        budget,
        tokens: 300,
      });
      if (fallbackRequests === 0) await expect(call).rejects.toThrow(BudgetExhausted);
      else await call;
      expect(fallback.requests).toHaveLength(fallbackRequests);
      expect(budget.spent).toBe(spent);
    }
  });

  it("P2: the parent keeps room for its final answer after a child with a long answer", async () => {
    const childModel = new FakeModelClient(
      Array.from({ length: 200 }, (_, i) =>
        reply(
          [text("x".repeat(2_000)), toolUse("upper", { text: `t${i}` })],
          undefined,
          usage(200, 50),
        ),
      ),
    );
    const kid = {
      name: "kid",
      description: "a subagent",
      inputSchema: (await import("zod")).z.object({}),
      readOnly: true,
      async run(_input: unknown, context: import("../src/tools/types.js").ToolContext) {
        return runChild(
          {
            ...childRun(childModel, "s", 1_000_000, new ToolRegistry([upperTool()])),
            limits: { maxSteps: 200, tokenBudget: 1_000_000 },
            maxTokens: 100,
          },
          context,
        );
      },
      toText: (output: { answer: string }) => output.answer,
      report: (output: { report: import("../src/session/records.js").SubagentReport }) =>
        output.report,
    };
    const parentModel = new FakeModelClient([
      reply([toolUse("kid", {})], undefined, usage(100, 20)),
      reply([text("final answer")], undefined, usage(900, 20)),
    ]);
    const session = createSession(base, "p", undefined);
    addUserMessage(session, "go");
    const result = await runAgent(session, {
      model: parentModel,
      tools: new ToolRegistry([kid as never]),
      system: "s",
      permissions: allowAll(base),
      maxTokens: 200,
      tokenBudget: 15_000,
    });
    expect(parentModel.requests).toHaveLength(2);
    expect(result.stopReason).toBe("done");
    expect(totalTokens(session.usage)).toBeLessThanOrEqual(15_000);
  });

  it("P2: charges with no reported usage stay with the session, also on resume", async () => {
    const { MemoryJournal } = await import("../src/session/store.js");
    const { rebuildState } = await import("../src/session/resume.js");
    const journal = new MemoryJournal();
    const session = createSession(base, "f", journal);
    addUserMessage(session, "go");
    const broken: ModelClient = {
      // biome-ignore lint/correctness/useYield: the stream fails before its first event.
      async *stream() {
        throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      },
    };
    const first = await runAgent(session, {
      model: broken,
      tools: new ToolRegistry(),
      system: "s",
      permissions: allowAll(base),
      maxTokens: 300,
      tokenBudget: 1_000,
      retryDelaysMs: [0, 0, 0],
    });
    expect(first.stopReason).toBe("token_budget");
    expect(session.unreportedTokens).toBeGreaterThan(600);
    // The next turn of the same session gets no new allowance.
    const next = new FakeModelClient([reply([text("hi")])]);
    addUserMessage(session, "again");
    const second = await runAgent(session, {
      model: next,
      tools: new ToolRegistry(),
      system: "s",
      permissions: allowAll(base),
      maxTokens: 300,
      tokenBudget: 1_000,
    });
    expect(second.stopReason).toBe("token_budget");
    expect(next.requests).toHaveLength(0);
    expect(rebuildState(journal.records).unreportedTokens).toBe(session.unreportedTokens);
  });

  it("P2: /compact reserves its summary request", async () => {
    const { compactNow } = await import("../src/context/compact.js");
    const session = createSession(base, "c2", undefined);
    for (let i = 0; i < 8; i++) {
      addUserMessage(session, `turn ${i}`);
      session.messages.push({ role: "assistant", content: [text(`answer ${i}`)] });
    }
    const model = new FakeModelClient([reply([text("summary")])]);
    await expect(
      compactNow(session, model, { budget: new TokenBudget(10) }, signal),
    ).rejects.toThrow(BudgetExhausted);
    expect(model.requests).toHaveLength(0);
    // Negative control: with room, the summary request runs.
    await compactNow(session, model, { budget: new TokenBudget(100_000) }, signal);
    expect(model.requests).toHaveLength(1);
  });
});

describe("no hidden SDK retries under the budget", () => {
  it("the Anthropic client asks the SDK for no retries of its own when a meter is set", async () => {
    const { AnthropicClient } = await import("../src/model/anthropic.js");
    const seen: unknown[] = [];
    const sdk = {
      messages: {
        stream: (_params: unknown, options: unknown) => {
          seen.push(options);
          throw new Error("stop here");
        },
      },
    };
    const client = new AnthropicClient({ model: "claude-x", client: sdk as never });
    const request: ModelRequest = { system: "s", messages: [], tools: [], maxTokens: 10 };
    const drain = async (options: Parameters<ModelClient["stream"]>[1]) => {
      for await (const _ of client.stream(request, options)) {
      }
    };
    await expect(drain({ signal, meter: { retry: () => {} } })).rejects.toThrow("stop here");
    await expect(drain({ signal })).rejects.toThrow("stop here");
    expect(seen[0]).toMatchObject({ maxRetries: 0 });
    expect(seen[1]).not.toHaveProperty("maxRetries");
  });
});
