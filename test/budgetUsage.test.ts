import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runChild } from "../src/agents/child.js";
import { assistantLine, resultLine } from "../src/cli/jsonOutput.js";
import { usageLine } from "../src/cli/report.js";
import { compactNow } from "../src/context/compact.js";
import { formatReport, runEvalTask } from "../src/evals/runner.js";
import { requestTokens, TokenBudget } from "../src/loop/budget.js";
import { callModelWithRetry } from "../src/loop/callModel.js";
import { runAgent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { OpenAICompatibleClient } from "../src/model/openaiCompatible.js";
import { responseCost, totalTokens } from "../src/model/pricing.js";
import { ZERO_USAGE } from "../src/model/types.js";
import { rebuildState, resumeSession } from "../src/session/resume.js";
import {
  addAssistantResponse,
  addUnreported,
  addUserMessage,
  budgetSpent,
  createSession,
} from "../src/session/session.js";
import { FileSessionStore, MemoryJournal } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { allowAll } from "./helpers.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "garuda-budget-usage-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const signal = new AbortController().signal;
const price = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
const request = { system: "s", messages: [], tools: [], maxTokens: 900 };

function compatible(usage?: unknown) {
  let posts = 0;
  const model = new OpenAICompatibleClient({
    provider: "test",
    baseUrl: "https://example.invalid/v1",
    model: "test",
    fetch: async () => {
      posts++;
      const chunk = {
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        ...(usage === undefined ? {} : { usage }),
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return { model, posts: () => posts };
}

describe("successful responses without reported usage", () => {
  const incomplete = [
    ["missing", undefined],
    ["null", null],
    ["input only", { prompt_tokens: 5 }],
    ["output only", { completion_tokens: 2 }],
    ["negative", { prompt_tokens: 5, completion_tokens: -1 }],
    ["fractional", { prompt_tokens: 5, completion_tokens: 0.5 }],
    ["non-number", { prompt_tokens: "5", completion_tokens: 2 }],
    [
      "invalid cache",
      { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 6 } },
    ],
  ] as const;
  it.each(incomplete)("keeps the full reservation for %s usage", async (_name, wireUsage) => {
    const { model } = compatible(wireUsage);
    const budget = new TokenBudget(1_000);
    const response = await callModelWithRetry(model, request, signal, () => {}, [], {
      budget,
      tokens: 1_000,
    });
    expect.soft(budget.spent).toBe(1_000);
    expect.soft(budget.left).toBe(0);
    expect.soft(response).toMatchObject({ usageReported: false });
    // Estimates remain available for context sizing, but are not treated as billing evidence.
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(responseCost(response, price)).toBeUndefined();
  });

  it.each([
    ["ordinary", { prompt_tokens: 5, completion_tokens: 2 }, 7],
    [
      "cached",
      { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } },
      7,
    ],
    ["zero", { prompt_tokens: 0, completion_tokens: 0 }, 0],
  ] as const)("settles to complete provider usage (%s)", async (_name, wireUsage, spent) => {
    const { model } = compatible(wireUsage);
    const budget = new TokenBudget(1_000);
    const response = await callModelWithRetry(model, request, signal, () => {}, [], {
      budget,
      tokens: 1_000,
    });
    expect(budget.spent).toBe(spent);
    expect(budget.left).toBe(1_000 - spent);
    expect(totalTokens(response.usage)).toBe(spent);
    expect(responseCost(response, price)).toBe(spent / 1_000_000);
  });

  it("persists one charge across resume, refuses the next call and labels the estimates", async () => {
    const store = new FileSessionStore(root);
    const journal = store.open("unknown-usage");
    const start = {
      root,
      version: "test",
      model: "test",
      executor: "none",
      isolation: "none",
      limits: { maxSteps: 3, tokenBudget: 1_000, contextWindow: 100_000 },
    };
    journal.write({ type: "start", sessionId: "unknown-usage", ...start });
    const session = createSession(root, "unknown-usage", journal);
    addUserMessage(session, "go");
    const { model, posts } = compatible();
    const deps = {
      model,
      tools: new ToolRegistry(),
      system: "s",
      permissions: allowAll(root),
      maxTokens: 900,
      tokenBudget: 1_000,
      price,
    };
    const held = requestTokens(session, { ...request, messages: session.messages }) + 900;
    const result = await runAgent(session, deps);
    expect.soft(result.stopReason).toBe("done");
    expect.soft(session.unreportedTokens).toBe(held);
    expect.soft(budgetSpent(session)).toBe(held);
    expect.soft(session.usage).toEqual(ZERO_USAGE);
    expect.soft(result.usage).toEqual(ZERO_USAGE);
    expect.soft(session.costUsd).toBeUndefined();
    expect(session.contextTokens).toBeGreaterThan(0);
    const records = await store.read(session.id);
    const assistant = records.find((r) => r.type === "assistant");
    expect(assistant?.type).toBe("assistant");
    if (assistant?.type !== "assistant") throw new Error("missing response");
    expect(assistantLine(assistant.response, "test").message).toMatchObject({
      usage_is_estimated: true,
    });
    expect(usageLine(result, session, undefined, 100_000)).toContain(
      "reserved without reported usage",
    );
    expect(
      resultLine(
        { kind: "done", result },
        {
          model: "test",
          durationMs: 1,
          lastText: "ok",
          denials: [],
          totalCostUsd: 0,
          runCostUsd: undefined,
          contextWindow: 100_000,
          maxOutputTokens: 900,
        },
      ),
    ).toMatchObject({
      usage_is_incomplete: true,
      unreported_budget_tokens: held,
      cost_is_unknown: true,
    });

    const resumed = await resumeSession({ store, root, sessionId: session.id, start });
    expect.soft(resumed.usage).toEqual(ZERO_USAGE);
    expect.soft(resumed.costUsd).toBeUndefined();
    expect.soft(budgetSpent(resumed)).toBe(held);
    addUserMessage(resumed, "again");
    const next = await runAgent(resumed, deps);
    expect.soft(next.stopReason).toBe("token_budget");
    expect.soft(posts()).toBe(1);
    expect(budgetSpent(resumed)).toBe(held);
  });

  it("charges unknown child usage once, separately from the parent's reported usage", async () => {
    const journal = new MemoryJournal();
    const session = createSession(root, "unknown-child", journal);
    addUserMessage(session, "go");
    const child = compatible();
    const childSession = createSession(root);
    addUserMessage(childSession, "go");
    const held = requestTokens(childSession, { ...request, messages: childSession.messages }) + 900;
    const tools = new ToolRegistry([
      {
        name: "kid",
        description: "child",
        inputSchema: z.object({}),
        readOnly: true,
        run: (_input, context) =>
          runChild(
            {
              id: "kid",
              system: "s",
              prompt: "go",
              tools: new ToolRegistry(),
              permissions: allowAll(root),
              model: {
                spec: "test",
                client: async () => child.model,
                contextWindow: 100_000,
                price,
              },
              limits: { maxSteps: 3, tokenBudget: 1_000 },
              maxTokens: 900,
            },
            context,
          ),
        toText: (result) => result.answer,
        report: (result) => result.report,
      },
    ]);
    const parent = new FakeModelClient([reply([toolUse("kid", {})]), reply([text("done")])]);
    const result = await runAgent(session, {
      model: parent,
      tools,
      system: "s",
      permissions: allowAll(root),
      maxTokens: 100,
      tokenBudget: 100_000,
      price,
    });
    expect(result.stopReason).toBe("done");
    expect.soft(child.posts()).toBe(1);
    expect.soft(totalTokens(session.usage)).toBe(30);
    expect.soft(session.unreportedTokens).toBe(held);
    expect.soft(budgetSpent(session)).toBe(held + 30);
    expect.soft(session.costUsd).toBeUndefined();
    const rebuilt = rebuildState(journal.records);
    expect.soft(totalTokens(rebuilt.usage)).toBe(30);
    expect.soft(rebuilt.unreportedTokens).toBe(held);
    expect(rebuilt.costUsd).toBeUndefined();
  });

  it("charges an estimated compaction summary once and replays the same totals", async () => {
    const journal = new MemoryJournal();
    const session = createSession(root, "unknown-summary", journal);
    for (let i = 0; i < 4; i++) {
      addUserMessage(session, `turn ${i}: ${"x".repeat(200)}`);
      addAssistantResponse(session, reply([text("ok")]), i + 1, 0);
    }
    const before = budgetSpent(session);
    const budget = new TokenBudget(10_000, undefined, (tokens) => addUnreported(session, tokens));
    const { model } = compatible();
    await compactNow(
      session,
      model,
      { keepSteps: 1, budget, costOf: (r) => responseCost(r, price) },
      signal,
    );
    expect.soft(budget.spent).toBeGreaterThan(4_096);
    expect.soft(totalTokens(session.usage)).toBe(before);
    expect.soft(session.unreportedTokens).toBe(budget.spent);
    expect.soft(budgetSpent(session)).toBe(before + budget.spent);
    expect.soft(session.costUsd).toBeUndefined();
    const rebuilt = rebuildState(journal.records);
    expect.soft(totalTokens(rebuilt.usage)).toBe(before);
    expect.soft(rebuilt.unreportedTokens).toBe(budget.spent);
    expect(rebuilt.costUsd).toBeUndefined();
  });

  it("replays legacy responses without the usage flag as reported", () => {
    const journal = new MemoryJournal();
    const session = createSession(root, "legacy", journal);
    addUserMessage(session, "go");
    addAssistantResponse(session, reply([text("ok")]), 1, 0);
    const rebuilt = rebuildState(journal.records);
    expect(totalTokens(rebuilt.usage)).toBe(15);
    expect(rebuilt.unreportedTokens).toBe(0);
    expect(rebuilt.costUsd).toBe(0);
  });

  it("charges a child's estimated wrap-up without treating its estimates as a usage report", async () => {
    const parent = createSession(root);
    const budget = new TokenBudget(10_000, undefined, (tokens) => addUnreported(parent, tokens));
    const child = compatible();
    const result = await runChild(
      {
        id: "wrap-up",
        system: "s",
        prompt: "go",
        tools: new ToolRegistry(),
        permissions: allowAll(root),
        model: { spec: "test", client: async () => child.model, contextWindow: 100_000, price },
        limits: { maxSteps: 0, tokenBudget: 1_000 },
        maxTokens: 900,
      },
      { root, signal, permissions: allowAll(root), files: parent.files, budget },
    );
    expect(result.answer).toBe("ok");
    expect(child.posts()).toBe(1);
    expect(budget.spent).toBeGreaterThan(900);
    expect(budget.spent).toBeLessThanOrEqual(1_000);
    expect(parent.unreportedTokens).toBe(budget.spent);
    expect(result.report.usage).toEqual(ZERO_USAGE);
    expect(result.report.costUsd).toBeUndefined();
  });

  it("retains both reservations when an HTTP retry succeeds without usage", async () => {
    let posts = 0;
    const model = new OpenAICompatibleClient({
      provider: "test",
      baseUrl: "https://example.invalid/v1",
      model: "test",
      retryDelaysMs: [0],
      fetch: async () =>
        ++posts === 1
          ? new Response("retry", { status: 503 })
          : new Response(
              'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } },
            ),
    });
    const budget = new TokenBudget(2_000);
    await callModelWithRetry(model, request, signal, () => {}, [], { budget, tokens: 1_000 });
    expect(posts).toBe(2);
    expect(budget.spent).toBe(2_000);
    expect(budget.left).toBe(0);
  });

  it("keeps unknown charges from parallel children in their shared allowance", async () => {
    const parent = new TokenBudget(2_500);
    const children = Array.from({ length: 3 }, () => compatible());
    const results = await Promise.allSettled(
      children.map(({ model }) =>
        callModelWithRetry(model, request, signal, () => {}, [], {
          budget: parent.child(1_000),
          tokens: 1_000,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(children.reduce((sum, child) => sum + child.posts(), 0)).toBe(2);
    expect(parent.spent).toBe(2_000);
    expect(parent.left).toBe(500);
  });

  it("marks incomplete eval usage instead of presenting zero tokens and a numeric mean", async () => {
    const { model } = compatible();
    const result = await runEvalTask(
      {
        id: "usage-probe",
        title: "usage",
        prompt: "Say ok",
        files: {},
        solution: {},
        check: "true",
      },
      {
        modelId: "test",
        model: () => model,
        modelInfo: { price, contextWindow: 100_000 },
        executor: "host",
      },
    );
    expect(result.passed).toBe(true);
    expect(result.tokens).toBe(0);
    expect(result.unreportedTokens).toBeGreaterThan(0);
    expect(result.costUsd).toBeUndefined();
    const report = formatReport([result, { ...result }]);
    expect(report).toContain("tok ?");
    expect(report).toContain("cache share unknown");
    expect(report).toContain("Mean per task:");
    expect(report).not.toContain("0.0k tok");
  });
});
