import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { fromWireMessage, toWireParams } from "../src/model/anthropic.js";
import { FakeModelClient, reply, ScriptExhaustedError, text } from "../src/model/fake.js";
import type { ModelEvent, ModelRequest } from "../src/model/types.js";

const request: ModelRequest = {
  system: "sys",
  maxTokens: 100,
  tools: [
    { name: "a", description: "A", inputSchema: { type: "object", properties: {} } },
    { name: "b", description: "B", inputSchema: { type: "object", properties: {} } },
  ],
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "a", input: { x: 1 } }] },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "out", isError: false }],
    },
  ],
};

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("FakeModelClient (N4)", () => {
  it("streams text deltas, then one response", async () => {
    const model = new FakeModelClient([reply([text("hello")])]);
    const events = await collect(model.stream(request));
    expect(events.map((e) => e.type)).toEqual(["text_delta", "response"]);
  });

  it("records a copy of each request", async () => {
    const model = new FakeModelClient([reply([text("x")])]);
    const messages = [...request.messages];
    await collect(model.stream({ ...request, messages }));
    messages.push({ role: "user", content: [] });
    expect(model.requests[0]?.messages).toHaveLength(3);
  });

  it("fails when the script has no more steps", async () => {
    const model = new FakeModelClient([]);
    await expect(collect(model.stream(request))).rejects.toBeInstanceOf(ScriptExhaustedError);
  });
});

describe("Anthropic adapter mapping (N1, N2)", () => {
  it("maps a request to wire params with cache breakpoints", () => {
    const params = toWireParams("model-x", request);
    expect(params.model).toBe("model-x");
    expect(params.max_tokens).toBe(100);
    expect(params.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    const tools = params.tools as Anthropic.Messages.Tool[];
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(params.messages[1]?.content).toEqual([
      { type: "tool_use", id: "t1", name: "a", input: { x: 1 } },
    ]);
    expect(params.messages[2]?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "out",
        is_error: false,
        // The last block carries the conversation cache breakpoint.
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(params.messages[0]?.content).not.toContainEqual(
      expect.objectContaining({ cache_control: expect.anything() }),
    );
  });

  it("maps a wire message to a model response", () => {
    const wire = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "model-x",
      stop_reason: "tool_use",
      stop_sequence: null,
      content: [
        { type: "text", text: "Let me look.", citations: null },
        { type: "tool_use", id: "t9", name: "a", input: { q: 1 } },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: null,
      },
    } as unknown as Anthropic.Messages.Message;

    expect(fromWireMessage(wire)).toEqual({
      content: [
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "t9", name: "a", input: { q: 1 } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 0 },
    });
  });
});

describe("Anthropic adapter with no tools", () => {
  it("omits the tools field", () => {
    expect(toWireParams("m", { ...request, tools: [] }).tools).toBeUndefined();
  });
});
