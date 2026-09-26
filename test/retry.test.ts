import { describe, expect, it } from "vitest";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { PlainRenderer } from "../src/cli/renderer.js";
import { type AgentEvent, runAgent } from "../src/loop/runAgent.js";
import { errorReason, isTransientModelError } from "../src/model/errors.js";
import { reply, text } from "../src/model/fake.js";
import type { ModelClient, ModelEvent, ModelRequest } from "../src/model/types.js";
import { addUserMessage, createSession } from "../src/session/session.js";
import { MemoryJournal } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { allowAll, sink } from "./helpers.js";

/** A model whose first `failures` streams break after some text. */
class FlakyModel implements ModelClient {
  calls = 0;
  constructor(
    private readonly failures: number,
    private readonly error: unknown = new TypeError("terminated"),
  ) {}

  async *stream(_request: ModelRequest): AsyncIterable<ModelEvent> {
    this.calls++;
    yield { type: "text_delta", text: "Half a sen" };
    if (this.calls <= this.failures) throw this.error;
    const response = reply([text("A full answer.")]);
    yield { type: "response", response };
  }
}

function run(model: ModelClient, signal?: AbortSignal, delays: number[] = [0, 0]) {
  const journal = new MemoryJournal();
  const session = createSession("/r", "s1", journal);
  addUserMessage(session, "hi");
  const events: AgentEvent[] = [];
  const result = runAgent(session, {
    model,
    tools: new ToolRegistry([]),
    system: "sys",
    permissions: allowAll(),
    onEvent: (e) => events.push(e),
    retryDelaysMs: delays,
    ...(signal === undefined ? {} : { signal }),
  });
  return { session, journal, events, result };
}

describe("transient model errors (0.3)", () => {
  it("finds broken connections, resets, timeouts and overloads", () => {
    const transient = [
      new TypeError("terminated"),
      Object.assign(new Error("Connection error."), { name: "APIConnectionError" }),
      Object.assign(new Error("read"), { code: "ECONNRESET" }),
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("x"), { code: "UND_ERR_SOCKET" }),
      }),
      new AggregateError([Object.assign(new Error("a"), { code: "ETIMEDOUT" })], "all failed"),
      { status: 529, message: "Overloaded" },
      { status: 503, message: "Service Unavailable" },
      { error: { type: "overloaded_error", message: "Overloaded" } },
      { error: { error: { type: "overloaded_error" } } },
      new Error("Model stream ended without a response."),
    ];
    for (const error of transient) expect(isTransientModelError(error), String(error)).toBe(true);
  });

  it("does not retry what a retry cannot fix", () => {
    const final = [
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
      { status: 400, message: "prompt is too long" },
      { status: 401, message: "invalid x-api-key" },
      { status: 429, message: "rate limited", error: { type: "overloaded_error" } },
      new Error("Cannot reach ollama at http://localhost:11434/v1. Is the server running?"),
      new Error("ollama answered 404: model not found"),
      null,
      "terminated",
    ];
    for (const error of final) expect(isTransientModelError(error), String(error)).toBe(false);
  });

  it("gives a short reason", () => {
    expect(errorReason(new TypeError("terminated"))).toBe("terminated");
    expect(errorReason(Object.assign(new Error("read"), { code: "ECONNRESET" }))).toBe(
      "ECONNRESET",
    );
    expect(errorReason(new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } }))).toBe(
      "UND_ERR_SOCKET",
    );
  });
});

describe("the loop retries a broken stream (0.3)", () => {
  it("sends the request again, and the session keeps only the full response", async () => {
    const model = new FlakyModel(2);
    const { session, journal, events, result } = run(model);
    expect((await result).stopReason).toBe("done");
    expect(model.calls).toBe(3);
    expect(events.filter((e) => e.type === "model_retry")).toEqual([
      { type: "model_retry", attempt: 1, maxRetries: 2, delayMs: 0, reason: "terminated" },
      { type: "model_retry", attempt: 2, maxRetries: 2, delayMs: 0, reason: "terminated" },
    ]);
    expect(session.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "A full answer." }],
    });
    expect(journal.records.filter((r) => r.type === "assistant")).toHaveLength(1);
    expect(session.usage.inputTokens).toBe(10);
  });

  it("gives up after the last retry", async () => {
    const model = new FlakyModel(5);
    const { events, result } = run(model);
    await expect(result).rejects.toThrow("terminated");
    expect(model.calls).toBe(3);
    expect(events.filter((e) => e.type === "model_retry")).toHaveLength(2);
  });

  it("does not retry an error that is not transient", async () => {
    const model = new FlakyModel(1, Object.assign(new Error("bad request"), { status: 400 }));
    const { events, result } = run(model);
    await expect(result).rejects.toThrow("bad request");
    expect(model.calls).toBe(1);
    expect(events.some((e) => e.type === "model_retry")).toBe(false);
  });

  it("Ctrl-C during the wait stops at once", async () => {
    const controller = new AbortController();
    const model = new FlakyModel(1);
    const { events, result } = run(model, controller.signal, [60_000]);
    await new Promise((r) => setTimeout(r, 10));
    expect(events.some((e) => e.type === "model_retry")).toBe(true);
    controller.abort(new Error("stopped by the user"));
    await expect(result).rejects.toThrow("stopped by the user");
    expect(model.calls).toBe(1);
  });
});

describe("retry notices", () => {
  const event: AgentEvent = {
    type: "model_retry",
    attempt: 1,
    maxRetries: 2,
    delayMs: 1_000,
    reason: "terminated",
  };

  it("the plain renderer warns on stderr", () => {
    const out = sink();
    const err = sink();
    const renderer = new PlainRenderer({ out: out.stream, err: err.stream }, false);
    renderer.event({ type: "text_delta", text: "Half a sen" });
    renderer.event(event);
    expect(err.text()).toBe("The connection to the model broke (terminated). Retrying (1/2)…\n");
  });

  it("the chat drops the unfinished text and shows a note", () => {
    const store = new ChatStore({ model: "fake", sandbox: "none" }, { paint: noColor });
    store.begin("task");
    store.event({ type: "text_delta", text: "Half a sen" });
    store.event(event);
    expect(store.getState().streaming).toBe("");
    expect(
      store
        .getState()
        .items.map((i) => i.text)
        .at(-1),
    ).toBe("The connection to the model broke (terminated). Retrying (1/2)…");
  });
});
