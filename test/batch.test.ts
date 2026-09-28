import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { runEvals } from "../src/evals/runner.js";
import { EVAL_TASKS } from "../src/evals/tasks.js";
import { AnthropicBatchClient } from "../src/model/anthropic.js";
import { isTransientModelError } from "../src/model/errors.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { costOf, responseCost } from "../src/model/pricing.js";
import { resolveModel } from "../src/model/providers.js";
import type { ModelEvent } from "../src/model/types.js";

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [{ type: "text", text: "Hello from the batch.", citations: null }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 0,
  },
};

/** A fake SDK: the batch ends after `polls` status checks with the given result. */
function fakeSdk(result: unknown, polls = 2) {
  const calls: string[] = [];
  let created: unknown;
  let checks = 0;
  const sdk = {
    messages: {
      batches: {
        create: async (params: unknown) => {
          created = params;
          calls.push("create");
          return { id: "batch_1" };
        },
        retrieve: async (id: string) => {
          calls.push(`retrieve ${id}`);
          checks++;
          return { processing_status: checks >= polls ? "ended" : "in_progress" };
        },
        cancel: async (id: string) => {
          calls.push(`cancel ${id}`);
          return {};
        },
        results: async (id: string) => {
          calls.push(`results ${id}`);
          return (async function* () {
            yield { custom_id: "garuda", result };
          })();
        },
      },
    },
  };
  return { sdk: sdk as unknown as Anthropic, calls, created: () => created };
}

const request = {
  system: "s",
  messages: [{ role: "user" as const, content: [text("hi")] }],
  tools: [],
  maxTokens: 100,
};

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("the Batch API client (0.7)", () => {
  it("sends one request as a batch, waits until it ends, and gives the response", async () => {
    const fake = fakeSdk({ type: "succeeded", message: MESSAGE }, 2);
    const client = new AnthropicBatchClient({
      model: "claude-sonnet-5",
      client: fake.sdk,
      pollMs: [0],
    });
    const events = await collect(client.stream(request));
    expect(events).toEqual([
      { type: "text_delta", text: "Hello from the batch." },
      {
        type: "response",
        response: {
          content: [{ type: "text", text: "Hello from the batch." }],
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0 },
          priceFactor: 0.5,
        },
      },
    ]);
    expect(fake.calls).toEqual([
      "create",
      "retrieve batch_1",
      "retrieve batch_1",
      "results batch_1",
    ]);
    const sent = fake.created() as {
      requests: { custom_id: string; params: Record<string, unknown> }[];
    };
    expect(sent.requests).toHaveLength(1);
    expect(sent.requests[0]?.custom_id).toBe("garuda");
    expect(sent.requests[0]?.params.model).toBe("claude-sonnet-5");
    // The same cache marks as a normal request: the system prompt is cached.
    expect(JSON.stringify(sent.requests[0]?.params.system)).toContain("ephemeral");
  });

  it("an overloaded result is transient (the loop retries); an expired one is not", async () => {
    const overloaded = fakeSdk({
      type: "errored",
      error: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    });
    const a = new AnthropicBatchClient({ model: "m", client: overloaded.sdk, pollMs: [0] });
    const error = await collect(a.stream(request)).catch((e: unknown) => e);
    expect((error as Error).message).toBe("Batch request failed: Overloaded");
    expect(isTransientModelError(error)).toBe(true);

    const expired = fakeSdk({ type: "expired" });
    const b = new AnthropicBatchClient({ model: "m", client: expired.sdk, pollMs: [0] });
    const late = await collect(b.stream(request)).catch((e: unknown) => e);
    expect((late as Error).message).toBe("The batch request was expired.");
    expect(isTransientModelError(late)).toBe(false);
  });

  it("an abort while it waits cancels the batch", async () => {
    const fake = fakeSdk({ type: "succeeded", message: MESSAGE }, 1_000);
    const client = new AnthropicBatchClient({ model: "m", client: fake.sdk, pollMs: [20] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stop")), 50);
    const error = await collect(client.stream(request, { signal: controller.signal })).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toBe("stop");
    expect(fake.calls.at(-1)).toBe("cancel batch_1");
    expect(fake.calls).not.toContain("results batch_1");
  });

  it("half price for every token kind; only Anthropic models have a batch client", () => {
    const price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      webSearches: 2,
    };
    // Tokens at half price; searches at full price.
    expect(costOf(usage, price, 0.5)).toBeCloseTo((2 + 10 + 0.2 + 2.5) / 2 + 0.02);
    expect(
      responseCost({ content: [], stopReason: "end_turn", usage, priceFactor: 0.5 }, price),
    ).toBeCloseTo(costOf(usage, price, 0.5));
    expect(resolveModel("claude-sonnet-5").createBatch).toBeTypeOf("function");
    expect(resolveModel("ollama/qwen3-coder").createBatch).toBeUndefined();
  });
});

describe("eval: tasks at the same time (0.7)", () => {
  it("runs `parallel` tasks at once and keeps the task order in the results", async () => {
    const task = EVAL_TASKS.find((t) => t.id === "fix-add");
    if (task === undefined) throw new Error("fix-add is missing");
    let running = 0;
    let most = 0;
    const solve = () => {
      const steps = [
        reply([toolUse("read_file", { path: "src/math.js" }, "r1")]),
        reply([
          toolUse(
            "edit_file",
            { path: "src/math.js", old_string: "a - b", new_string: "a + b" },
            "e1",
          ),
        ]),
        reply([text("Fixed.")]),
      ];
      const fake = new FakeModelClient(steps);
      return {
        async *stream(req: Parameters<FakeModelClient["stream"]>[0]) {
          running++;
          most = Math.max(most, running);
          await new Promise((r) => setTimeout(r, 30));
          running--;
          yield* fake.stream(req);
        },
      };
    };
    const results = await runEvals(
      [task, { ...task, id: "fix-add-2" }, { ...task, id: "fix-add-3" }],
      { modelId: "fake", model: solve, parallel: 3 },
    );
    expect(results.map((r) => r.id)).toEqual(["fix-add", "fix-add-2", "fix-add-3"]);
    expect(results.every((r) => r.passed)).toBe(true);
    expect(most).toBe(3);
    expect(results[0]?.cacheReadTokens).toBe(0);
  });
});

describe("the finish-by switch for jobs (0.7)", () => {
  /** A client that answers after `ms`, or fails with the abort reason. */
  const slow = (ms: number, answer: string) => ({
    calls: 0,
    async *stream(_request: unknown, options?: { signal?: AbortSignal }) {
      this.calls++;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(options.signal?.reason);
        });
      });
      yield { type: "response" as const, response: reply([text(answer)]) };
    },
  });
  const textOf = (events: ModelEvent[]) =>
    events.flatMap((e) =>
      e.type === "response" ? e.response.content.map((b) => (b.type === "text" ? b.text : "")) : [],
    );

  it("uses the batch client before the switch time, then the normal API for good", async () => {
    const { DeadlineClient } = await import("../src/model/deadline.js");
    const batch = slow(10, "batch");
    const normal = slow(0, "normal");
    const client = new DeadlineClient(
      batch as never,
      async () => normal as never,
      new Date(Date.now() + 80),
    );
    expect(textOf(await collect(client.stream(request)))).toEqual(["batch"]);
    // This batch would take longer than the time left: it is cancelled and sent to the normal API.
    const late = new DeadlineClient(
      slow(1_000, "batch") as never,
      async () => normal as never,
      new Date(Date.now() + 30),
    );
    expect(textOf(await collect(late.stream(request)))).toEqual(["normal"]);
    expect(late.calls.switchedAt).toBeInstanceOf(Date);
    expect(textOf(await collect(late.stream(request)))).toEqual(["normal"]);
    expect(late.calls).toMatchObject({ primary: 0, fallback: 2 });
    // After the switch time, straight to the normal API.
    const past = new DeadlineClient(
      batch as never,
      async () => normal as never,
      new Date(Date.now() - 1),
    );
    expect(textOf(await collect(past.stream(request)))).toEqual(["normal"]);
  });

  it("the user's abort is not a switch", async () => {
    const { DeadlineClient } = await import("../src/model/deadline.js");
    const normal = slow(0, "normal");
    const client = new DeadlineClient(
      slow(1_000, "batch") as never,
      async () => normal as never,
      new Date(Date.now() + 60_000),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("Ctrl-C")), 20);
    const error = await collect(client.stream(request, { signal: controller.signal })).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toBe("Ctrl-C");
    expect(normal.calls).toBe(0);
  });

  it("switchTime is 15 minutes before the finish-by time", async () => {
    const { switchTime } = await import("../src/jobs/create.js");
    expect(switchTime("07:00")).toBe("06:45");
    expect(switchTime("00:10")).toBe("23:55");
  });
});

describe("slow batches (0.7)", () => {
  it("a step past the step limit runs on the normal API; the next step tries the batch again", async () => {
    const { DeadlineClient } = await import("../src/model/deadline.js");
    let batchCalls = 0;
    const batch = {
      async *stream(_r: unknown, options?: { signal?: AbortSignal }) {
        batchCalls++;
        const ms = batchCalls === 1 ? 1_000 : 5;
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, ms);
          options?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(options.signal?.reason);
          });
        });
        yield { type: "response" as const, response: reply([text("batch")]) };
      },
    };
    const normal = new FakeModelClient([reply([text("normal")])]);
    const client = new DeadlineClient(
      batch as never,
      async () => normal,
      new Date(Date.now() + 60_000),
      {
        stepLimitMs: 30,
      },
    );
    const first = await collect(client.stream(request));
    const second = await collect(client.stream(request));
    const texts = [first, second].map((events) =>
      events.flatMap((e) => (e.type === "response" ? [e.response.content[0]] : [])),
    );
    expect(texts).toEqual([[text("normal")], [text("batch")]]);
    expect(client.calls).toMatchObject({ primary: 1, fallback: 1, slow: 1, switchedAt: undefined });
  });

  it("tells the batch id and the wait; a failed status check is tried again", async () => {
    const fake = fakeSdk({ type: "succeeded", message: MESSAGE }, 3);
    let checks = 0;
    const retrieve = fake.sdk.messages.batches.retrieve.bind(fake.sdk.messages.batches);
    (fake.sdk.messages.batches as { retrieve: unknown }).retrieve = async (id: string) => {
      if (++checks === 1) throw new Error("socket hang up");
      return retrieve(id);
    };
    const waits: string[] = [];
    const client = new AnthropicBatchClient({
      model: "m",
      client: fake.sdk,
      pollMs: [0],
      noticeMs: 0,
      onWait: (w) => waits.push(`${w.batchId} ${w.status}`),
    });
    const events = await collect(client.stream(request));
    expect(events.at(-1)?.type).toBe("response");
    expect(waits[0]).toBe("batch_1 created");
    expect(waits).toContain("batch_1 check failed, trying again");
    expect(waits).toContain("batch_1 in_progress");
  });
});
