import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ChildResult, runChild } from "../src/agents/child.js";
import { compactNow } from "../src/context/compact.js";
import { approxTokens, BudgetExhausted, requestTokens, TokenBudget } from "../src/loop/budget.js";
import { callModelWithRetry } from "../src/loop/callModel.js";
import { runAgent } from "../src/loop/runAgent.js";
import { runTools } from "../src/loop/toolRunner.js";
import { AnthropicBatchClient } from "../src/model/anthropic.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { totalTokens } from "../src/model/pricing.js";
import type { ModelClient, ModelRequest, Usage } from "../src/model/types.js";
import { rebuildState, resumeSession } from "../src/session/resume.js";
import {
  addAssistantResponse,
  addChildDebit,
  addChildReport,
  addToolResults,
  addUnreported,
  addUserMessage,
  budgetSpent,
  createSession,
} from "../src/session/session.js";
import { FileSessionStore, type Journal, MemoryJournal } from "../src/session/store.js";
import { LIMITS } from "../src/tools/limits.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";
import { allowAll, toolContext, upperTool } from "./helpers.js";

/**
 * Step 1 baseline for the review of 6c9f929: these assert the intended behaviour.
 * Five cases fail on that commit; the repair makes them ordinary passing regressions.
 * No real provider requests, credentials, OS sandbox or external repository are required.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "garuda-budget-review-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const signal = new AbortController().signal;
const usage = (inputTokens: number, outputTokens: number): Usage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

function childTool(
  model: ModelClient,
  maxTokens: number,
  tools = new ToolRegistry(),
  journal?: Journal,
  id = "kid",
): Tool<Record<string, never>, ChildResult> {
  return {
    name: id,
    description: "child",
    inputSchema: z.object({}),
    readOnly: true,
    run: (_input, context) =>
      runChild(
        {
          id,
          system: "s",
          prompt: "go",
          tools,
          model: { spec: "fake", contextWindow: 100_000, client: async () => model },
          permissions: allowAll(root),
          limits: { maxSteps: 3, tokenBudget: 100_000 },
          maxTokens,
          ...(journal === undefined ? {} : { journal }),
        },
        context,
      ),
    toText: (output) => output.answer,
    report: (output) => output.report,
  };
}

describe("review baseline: budget lifecycle", () => {
  it("P2: custom runners obey the same complete-result cap as registry tools", async () => {
    const outcome = await runTools(
      [toolUse("custom", {})],
      {
        tools: {
          specs: () => [],
          isReadOnly: () => true,
          runsCommands: () => false,
          runsSubagent: () => true,
          async execute() {
            return { content: "\\".repeat(200_000), isError: false };
          },
        },
      },
      toolContext(root),
      () => {},
    );
    expect(outcome.results[0]?.content.length).toBe(LIMITS.childAnswerChars);
  });
  it("P1: an aborted parallel batch drains a late sibling and retains its reported usage", async () => {
    const controller = new AbortController();
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let lateFinished = false;
    const late: ModelClient = {
      async *stream(_request, options) {
        options?.signal?.throwIfAborted();
        markStarted();
        // Model usage can arrive while cancellation is already being processed.
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield { type: "response", response: reply([text("late")], undefined, usage(40, 10)) };
        lateFinished = true;
      },
    };
    const aborting: ModelClient = {
      // biome-ignore lint/correctness/useYield: this request fails before a response.
      async *stream() {
        await started;
        controller.abort(new Error("cancel parallel"));
        throw controller.signal.reason;
      },
    };
    const journal = new MemoryJournal();
    const session = createSession(root, "parallel", journal);
    addUserMessage(session, "go");
    const cap = 100_000;
    const budget = new TokenBudget(cap, undefined, (tokens) => addUnreported(session, tokens));
    const model = new FakeModelClient([
      reply([toolUse("late", {}), toolUse("abort", {})], undefined, usage(100, 20)),
    ]);
    await expect(
      runAgent(session, {
        model,
        tools: new ToolRegistry([
          childTool(late, 100, new ToolRegistry(), undefined, "late"),
          childTool(aborting, 100, new ToolRegistry(), undefined, "abort"),
        ]),
        system: "s",
        permissions: allowAll(root),
        maxTokens: 200,
        tokenBudget: cap,
        signal: controller.signal,
        budget,
      }),
    ).rejects.toThrow("cancel parallel");
    expect(lateFinished).toBe(true);
    expect(session.childDebits.get("late")).toBe(50);
    expect(budget.left + budget.spent).toBe(cap);
    expect(budgetSpent(session)).toBe(budget.spent);
    expect(budgetSpent({ ...session, ...rebuildState(journal.records) })).toBe(budget.spent);
  });

  it("P1: nested child reports replace their durable debits exactly once on replay", async () => {
    const grand = new FakeModelClient([reply([text("grand")], undefined, usage(30, 10))]);
    const middle = new FakeModelClient([
      reply([toolUse("grand", {})], undefined, usage(20, 10)),
      reply([text("middle")], undefined, usage(10, 10)),
    ]);
    const model = new FakeModelClient([
      reply([toolUse("middle", {})], undefined, usage(100, 20)),
      reply([text("final")], undefined, usage(30, 10)),
    ]);
    const journal = new MemoryJournal();
    const session = createSession(root, "nested", journal);
    addUserMessage(session, "go");
    const budget = new TokenBudget(1_000_000);
    const grandTool = childTool(grand, 100, new ToolRegistry(), undefined, "grand");
    await runAgent(session, {
      model,
      tools: new ToolRegistry([
        childTool(middle, 100, new ToolRegistry([grandTool]), undefined, "middle"),
      ]),
      system: "s",
      permissions: allowAll(root),
      maxTokens: 200,
      tokenBudget: 1_000_000,
      budget,
    });
    expect(grand.requests.length).toBe(1);
    expect(middle.requests.length).toBe(2);
    expect(model.requests.length).toBe(2);
    expect(budget.spent).toBe(250);
    expect(totalTokens(session.usage)).toBe(250);
    expect(session.childDebits.size).toBe(0);
    const replayed = rebuildState(journal.records);
    expect(replayed.childDebits.size).toBe(0);
    expect(budgetSpent({ ...session, ...replayed })).toBe(250);
    const debits = journal.records.filter((record) => record.type === "child_debit");
    expect(debits.map((record) => record.childSessionId)).toEqual(["middle", "middle", "middle"]);
    expect(debits.map((record) => record.tokens)).toEqual([30, 40, 20]);
  });

  it("P1: a partial child report cannot erase descendant debits it does not include", () => {
    const journal = new MemoryJournal();
    const session = createSession(root, "partial", journal);
    addChildDebit(session, "middle", 90);
    const report = {
      sessionId: "middle",
      model: "fake",
      steps: 1,
      stopReason: "error",
      usage: usage(40, 10),
    };
    addToolResults(
      session,
      [],
      [{ toolUseId: "call", name: "middle", durationMs: 1, subagent: report }],
    );
    addChildReport(session, report);
    expect(session.childDebits.get("middle")).toBe(40);
    expect(budgetSpent(session)).toBe(90);
    expect(budgetSpent({ ...session, ...rebuildState(journal.records) })).toBe(90);
  });

  it("P1: pre-debit journals retain their original reported and unreported totals", () => {
    const journal = new MemoryJournal();
    const session = createSession(root, "legacy", journal);
    addAssistantResponse(session, reply([text("old")], undefined, usage(40, 10)), 1, undefined);
    addUnreported(session, 25);
    const rebuilt = rebuildState(journal.records);
    expect(rebuilt.childDebits.size).toBe(0);
    expect(budgetSpent({ ...session, ...rebuilt })).toBe(75);
  });

  it("P2: a generous allowance admits an escaped child answer and the final call", async () => {
    const child = new FakeModelClient([
      reply([text("\\".repeat(20_000))], undefined, usage(40, 5_000)),
    ]);
    const model = new FakeModelClient([
      reply([toolUse("kid", {})], undefined, usage(100, 20)),
      reply([text("final")], undefined, usage(10_200, 10)),
    ]);
    const session = createSession(root, "roomy");
    addUserMessage(session, "go");
    const result = await runAgent(session, {
      model,
      tools: new ToolRegistry([childTool(child, 6_000)]),
      system: "s",
      permissions: allowAll(root),
      tokenBudget: 100_000,
      maxTokens: 200,
    });
    expect(child.requests.length).toBe(1);
    expect(model.requests.length).toBe(2);
    expect(result.stopReason).toBe("done");
    expect(budgetSpent(session)).toBeLessThanOrEqual(100_000);
  });

  it.each([false, true])(
    "P2: final hook output is capped, including subagent metadata ($0)",
    async (subagent) => {
      const report = {
        sessionId: "hook",
        model: "fake",
        steps: 1,
        stopReason: "done",
        usage: usage(1, 1),
      };
      const tools = new ToolRegistry([
        {
          name: "hook",
          description: "hook",
          readOnly: true,
          inputSchema: z.object({}),
          async run() {
            return { report, answer: "x".repeat(20_000) };
          },
          toText: (output) => `${output.answer}\n${"metadata".repeat(10_000)}`,
          ...(subagent ? { report: (output: { report: typeof report }) => output.report } : {}),
        },
      ]);
      const outcome = await tools.execute(
        toolUse("hook", {}),
        toolContext(root, {
          hooks: {
            async before() {
              return undefined;
            },
            async after(_call, result) {
              return { ...result, content: result.content + "feedback".repeat(30_000) };
            },
          },
        }),
      );
      expect(outcome.content.length).toBeLessThanOrEqual(
        subagent ? LIMITS.childAnswerChars : LIMITS.resultChars,
      );
      expect(outcome.subagent).toEqual(subagent ? report : undefined);
    },
  );

  it.each([
    { total: 300, posts: 1, spent: 300, outcome: "error" },
    { total: 600, posts: 2, spent: 330, outcome: "success" },
  ])("P1: batch attempts reserve separately with $total tokens available", async (expected) => {
    let posts = 0;
    const batch = {
      id: "batch_1",
      type: "message_batch",
      processing_status: "ended",
      results_url: "https://example.test/results",
    };
    // Exercise the real SDK's retry implementation, while intercepting every HTTP request.
    const sdk = new Anthropic({
      apiKey: "test",
      baseURL: "https://example.test",
      fetch: async (input, init) => {
        if (init?.method === "POST") {
          posts++;
          if (posts === 1) {
            return new Response(
              JSON.stringify({
                type: "error",
                error: { type: "overloaded_error", message: "retry" },
              }),
              {
                status: 503,
                headers: { "content-type": "application/json", "retry-after": "0" },
              },
            );
          }
          return Response.json(batch);
        }
        if (String(input).endsWith("/results")) {
          return new Response(
            `${JSON.stringify({
              custom_id: "garuda",
              result: {
                type: "succeeded",
                message: {
                  id: "msg_1",
                  type: "message",
                  role: "assistant",
                  model: "claude-x",
                  content: [{ type: "text", text: "ok" }],
                  stop_reason: "end_turn",
                  stop_sequence: null,
                  usage: { input_tokens: 20, output_tokens: 10 },
                },
              },
            })}\n`,
            { headers: { "content-type": "application/x-jsonl" } },
          );
        }
        return Response.json(batch);
      },
    });
    const client = new AnthropicBatchClient({ model: "claude-x", client: sdk, pollMs: [0] });
    const budget = new TokenBudget(expected.total);
    const request: ModelRequest = { system: "s", messages: [], tools: [], maxTokens: 100 };
    const outcome = await callModelWithRetry(client, request, signal, () => {}, [0], {
      budget,
      tokens: 300,
    }).then(
      () => "success",
      () => "error",
    );
    console.info("batch baseline", { posts, spent: budget.spent, outcome });
    expect.soft(posts).toBe(expected.posts);
    expect.soft(budget.spent).toBe(expected.spent);
    expect.soft(outcome).toBe(expected.outcome);
  });

  it("P1: successful child usage survives cancellation, resume and the next turn", async () => {
    const controller = new AbortController();
    const store = new FileSessionStore(root);
    const journal = store.open("cancel-parent");
    // Leave enough for the new worst-case serialized-result floor so the child actually runs.
    const cap = 100_000;
    const start = {
      root,
      version: "baseline",
      model: "fake",
      executor: "none",
      isolation: "none",
      limits: { maxSteps: 10, tokenBudget: cap, contextWindow: 100_000 },
    };
    journal.write({ type: "start", sessionId: "cancel-parent", ...start });
    const session = createSession(root, "cancel-parent", journal);
    addUserMessage(session, "go");
    const budget = new TokenBudget(cap, undefined, (tokens) => addUnreported(session, tokens));
    const first = new FakeModelClient([
      reply([toolUse("upper", { text: "go" })], undefined, usage(40, 10)),
    ]);
    const childModel: ModelClient = {
      async *stream(request, options) {
        if (first.requests.length === 0) {
          yield* first.stream(request, options);
          return;
        }
        controller.abort(new Error("cancel child"));
        throw controller.signal.reason;
      },
    };
    const parent = new FakeModelClient([reply([toolUse("kid", {})], undefined, usage(100, 20))]);
    await expect(
      runAgent(session, {
        model: parent,
        tools: new ToolRegistry([
          childTool(
            childModel,
            100,
            new ToolRegistry([upperTool()]),
            store.openChild(session.id, "kid"),
          ),
        ]),
        system: "s",
        permissions: allowAll(root),
        tokenBudget: cap,
        maxTokens: 200,
        budget,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancel child");

    const records = await store.read(session.id);
    const rebuilt = rebuildState(records);
    const resumed = await resumeSession({ store, root, sessionId: session.id, start });
    const persisted = budgetSpent(session);
    const replayed = budgetSpent({ ...session, ...rebuilt });
    const restored = budgetSpent(resumed);
    expect(session.childDebits.get("kid")).toBe(50);
    expect(budget.spent).toBe(170 + session.unreportedTokens);
    expect.soft(persisted).toBe(budget.spent);
    expect.soft(replayed).toBe(budget.spent);
    expect.soft(restored).toBe(budget.spent);

    // One more than the real remainder must be refused, even if a previous debit was lost.
    addUserMessage(resumed, "again");
    const request: ModelRequest = {
      system: "s",
      messages: resumed.messages,
      tools: [],
      maxTokens: 0,
    };
    const inputTokens = requestTokens(resumed, request);
    const maxTokens = cap - budget.spent + 1 - inputTokens;
    const next = new FakeModelClient([
      reply([text("s".repeat(maxTokens * 4))], undefined, usage(inputTokens, maxTokens)),
    ]);
    const result = await runAgent(resumed, {
      model: next,
      tools: new ToolRegistry(),
      system: "s",
      permissions: allowAll(root),
      tokenBudget: cap,
      maxTokens,
    });
    console.info("cancel baseline", {
      spent: budget.spent,
      persisted,
      replayed,
      restored,
      nextCalls: next.requests.length,
      nextStop: result.stopReason,
      trueLifetimeSpend: budget.spent + totalTokens(result.usage),
      cap,
    });
    expect.soft(next.requests.length).toBe(0);
    expect.soft(result.stopReason).toBe("token_budget");
    expect.soft(budget.spent + totalTokens(result.usage)).toBeLessThanOrEqual(cap);
  });

  for (const char of ["x", "\\"]) {
    it(`P2: the parent can answer after a bounded child result (${JSON.stringify(char)})`, async () => {
      const child = new FakeModelClient([
        reply([text(char.repeat(20_000))], undefined, usage(40, 5_000)),
      ]);
      const parent = new FakeModelClient([
        reply([toolUse("kid", {})], undefined, usage(100, 20)),
        reply([text("final")], undefined, usage(50, 10)),
      ]);
      const session = createSession(root, `floor-${char === "x" ? "plain" : "escaped"}`);
      addUserMessage(session, "go");
      const result = await runAgent(session, {
        model: parent,
        tools: new ToolRegistry([childTool(child, 6_000)]),
        system: "s",
        permissions: allowAll(root),
        tokenBudget: 12_000,
        maxTokens: 200,
      });
      console.info("floor baseline", {
        char,
        childCalls: child.requests.length,
        parentCalls: parent.requests.length,
        stop: result.stopReason,
        spent: budgetSpent(session),
      });
      // Both cases permit safe refusal of child work if that is necessary to protect the
      // parent's final request. Admission depends on the eventual serialization-bound policy.
      expect.soft(parent.requests.length).toBe(2);
      expect.soft(result.stopReason).toBe("done");
      expect.soft(budgetSpent(session)).toBeLessThanOrEqual(12_000);
    });
  }

  it("P2: the hard tool-result cap covers thrown errors", async () => {
    const tools = new ToolRegistry([
      {
        name: "fail",
        description: "fail",
        inputSchema: z.object({}),
        readOnly: true,
        async run() {
          throw new Error("x".repeat(200_000));
        },
      },
    ]);
    const outcome = await tools.execute(toolUse("fail", {}), toolContext(root));
    console.info("error baseline", { length: outcome.content.length, bound: LIMITS.resultChars });
    expect(outcome.isError).toBe(true);
    expect(outcome.content.length).toBeLessThanOrEqual(LIMITS.resultChars);
  });

  it("P2: /compact reserves its full request, including the system prompt", async () => {
    const session = createSession(root, "compact");
    addUserMessage(session, "go");
    for (let i = 0; i < 5; i++) {
      addAssistantResponse(session, reply([text("a")], undefined, usage(1, 1)), i + 1, undefined);
      addUserMessage(session, "continue");
    }
    const roomy = new FakeModelClient([reply([text("summary")])]);
    // Keep class instances (FileTracker) intact while isolating the conversation changes.
    const probe = { ...session, messages: structuredClone(session.messages) };
    await compactNow(probe, roomy, {}, signal);
    const request = roomy.requests[0];
    if (request === undefined) throw new Error("The control did not make a summary request.");
    const partial =
      Math.max(session.contextTokens, approxTokens(JSON.stringify(request.messages))) +
      request.maxTokens;
    const full =
      approxTokens(
        JSON.stringify({
          system: request.system,
          messages: request.messages,
          tools: request.tools,
        }),
      ) + request.maxTokens;
    const model = new FakeModelClient([
      reply(
        [text("s".repeat(request.maxTokens * 4))],
        undefined,
        usage(full - request.maxTokens, request.maxTokens),
      ),
    ]);
    const budget = new TokenBudget(partial);
    const error = await compactNow(session, model, { budget }, signal).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    console.info("compact baseline", {
      partial,
      full,
      spent: budget.spent,
      calls: model.requests.length,
    });
    expect(full).toBeGreaterThan(partial);
    expect.soft(model.requests.length).toBe(0);
    expect.soft(error).toBeInstanceOf(BudgetExhausted);
    expect.soft(budget.spent).toBeLessThanOrEqual(partial);
  });
});
