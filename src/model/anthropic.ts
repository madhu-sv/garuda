import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  Message,
  ModelClient,
  ModelEvent,
  ModelRequest,
  ModelResponse,
  StopReason,
  StreamOptions,
  TextBlock,
  ToolSpec,
  ToolUseBlock,
  Usage,
} from "./types.js";

export interface AnthropicClientOptions {
  model: string;
  apiKey?: string;
  /** For tests: inject a prebuilt SDK client. */
  client?: Anthropic;
}

/**
 * The Anthropic adapter (N1). It is the only module that imports the Anthropic SDK.
 * It marks the system prompt, the tool list and the end of the conversation for prompt caching (N2).
 */
export class AnthropicClient implements ModelClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: AnthropicClientOptions) {
    this.model = options.model;
    this.client =
      options.client ??
      new Anthropic(options.apiKey === undefined ? {} : { apiKey: options.apiKey });
  }

  async *stream(request: ModelRequest, options?: StreamOptions): AsyncIterable<ModelEvent> {
    const stream = this.client.messages.stream(
      toWireParams(this.model, request),
      options?.signal === undefined ? {} : { signal: options.signal },
    );
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text_delta", text: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    yield { type: "response", response: fromWireMessage(final) };
  }
}

// Mapping functions. They are pure and exported for unit tests.

export function toWireParams(
  model: string,
  request: ModelRequest,
): Anthropic.Messages.MessageStreamParams {
  const params: Anthropic.Messages.MessageStreamParams = {
    model,
    max_tokens: request.maxTokens,
    system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
    messages: request.messages.map(toWireMessage),
  };
  // A breakpoint on the last block caches the conversation so far. The next request reads it.
  const last = params.messages.at(-1);
  if (last !== undefined && Array.isArray(last.content) && last.content.length > 0) {
    const blocks = last.content as Array<{
      cache_control?: Anthropic.Messages.CacheControlEphemeral;
    }>;
    const block = blocks[blocks.length - 1];
    if (block !== undefined) block.cache_control = { type: "ephemeral" };
  }
  if (request.tools.length > 0) params.tools = toWireTools(request.tools);
  return params;
}

export function toWireTools(tools: readonly ToolSpec[]): Anthropic.Messages.ToolUnion[] {
  return tools.map((tool, index): Anthropic.Messages.Tool => {
    const wire: Anthropic.Messages.Tool = {
      name: tool.name,
      description: tool.description,
      input_schema: { ...tool.inputSchema, type: "object" },
    };
    // One cache breakpoint after the last tool caches the whole tool list.
    if (index === tools.length - 1) wire.cache_control = { type: "ephemeral" };
    return wire;
  });
}

export function toWireMessage(message: Message): Anthropic.Messages.MessageParam {
  return { role: message.role, content: message.content.map(toWireBlock) };
}

function toWireBlock(block: ContentBlock): Anthropic.Messages.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
  }
}

export function fromWireMessage(message: Anthropic.Messages.Message): ModelResponse {
  const content: Array<TextBlock | ToolUseBlock> = [];
  for (const block of message.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "tool_use") {
      content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    }
    // 0.1 ignores other block types (thinking, server tools).
  }
  return {
    content,
    stopReason: fromWireStopReason(message.stop_reason),
    usage: fromWireUsage(message.usage),
  };
}

function fromWireStopReason(reason: Anthropic.Messages.StopReason | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function fromWireUsage(usage: Anthropic.Messages.Usage): Usage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}
