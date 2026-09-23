import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicClient } from "../src/model/anthropic.js";
import type { ModelEvent } from "../src/model/types.js";

/** A server-sent-events body in the Messages streaming format. */
function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

const BODY = sse([
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "m",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 9, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "t1", name: "upper", input: {} },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"text":"hi"}' },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 4 },
  },
  { type: "message_stop" },
]);

describe("AnthropicClient.stream (N1)", () => {
  it("streams text deltas and maps the final message", async () => {
    let sentBody: unknown;
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(BODY, { headers: { "content-type": "text/event-stream" } });
    };
    const sdk = new Anthropic({ apiKey: "test", fetch, maxRetries: 0 });
    const client = new AnthropicClient({ model: "m", client: sdk });

    const events: ModelEvent[] = [];
    for await (const event of client.stream({
      system: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      maxTokens: 50,
    })) {
      events.push(event);
    }

    expect(sentBody).toMatchObject({ model: "m", max_tokens: 50, stream: true });
    expect(events.slice(0, 2)).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
    ]);
    expect(events[2]).toEqual({
      type: "response",
      response: {
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "t1", name: "upper", input: { text: "hi" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    });
  });
});
