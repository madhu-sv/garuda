import Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantBlock,
  ContentBlock,
  Message,
  ModelClient,
  ModelEvent,
  ModelRequest,
  ModelResponse,
  ServerToolResultBlock,
  ServerToolSpec,
  StopReason,
  StreamOptions,
  ToolSpec,
  Usage,
} from "./types.js";

/** The web search tool version (0.6). Dynamic filtering (20260209+) waits for an A/B eval. */
export const WEB_SEARCH_TOOL = "web_search_20250305";

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
  /** Claude's web search runs on Anthropic's servers (0.6). */
  readonly serverTools = ["web_search"] as const;
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
  const tools = toWireTools(request.tools, request.serverTools ?? []);
  if (tools.length > 0) params.tools = tools;
  return params;
}

export function toWireTools(
  tools: readonly ToolSpec[],
  serverTools: readonly ServerToolSpec[] = [],
): Anthropic.Messages.ToolUnion[] {
  const out: Anthropic.Messages.ToolUnion[] = [
    ...tools.map(
      (tool): Anthropic.Messages.Tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: { ...tool.inputSchema, type: "object" },
      }),
    ),
    ...serverTools.map(
      (spec): Anthropic.Messages.WebSearchTool20250305 => ({
        type: WEB_SEARCH_TOOL,
        name: "web_search",
        max_uses: spec.maxUses,
        ...(spec.allowedDomains === undefined ? {} : { allowed_domains: [...spec.allowedDomains] }),
        ...(spec.blockedDomains === undefined ? {} : { blocked_domains: [...spec.blockedDomains] }),
      }),
    ),
  ];
  // One cache breakpoint after the last tool caches the whole tool list.
  const last = out.at(-1) as
    | { cache_control?: Anthropic.Messages.CacheControlEphemeral }
    | undefined;
  if (last !== undefined) last.cache_control = { type: "ephemeral" };
  return out;
}

export function toWireMessage(message: Message): Anthropic.Messages.MessageParam {
  return { role: message.role, content: message.content.map(toWireBlock) };
}

function toWireBlock(block: ContentBlock): Anthropic.Messages.ContentBlockParam {
  switch (block.type) {
    case "text":
      return block.citations === undefined
        ? { type: "text", text: block.text }
        : {
            type: "text",
            text: block.text,
            citations: structuredClone(block.citations) as Anthropic.Messages.TextCitationParam[],
          };
    // Server tool blocks go back exactly as they came (the results hold encrypted content).
    case "server_tool_use":
    case "server_tool_result":
      return structuredClone(block.wire) as Anthropic.Messages.ContentBlockParam;
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
  const content: AssistantBlock[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      const citations = block.citations ?? [];
      content.push(
        citations.length === 0
          ? { type: "text", text: block.text }
          : { type: "text", text: block.text, citations: structuredClone(citations) },
      );
    } else if (block.type === "tool_use") {
      content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    } else if (block.type === "server_tool_use") {
      content.push({
        type: "server_tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
        wire: structuredClone(block),
      });
    } else if (block.type === "web_search_tool_result") {
      content.push(webSearchResult(block));
    }
    // Other block types (thinking, other server tools) are not requested, so they do not come.
  }
  return {
    content,
    stopReason: fromWireStopReason(message.stop_reason),
    usage: fromWireUsage(message.usage),
  };
}

function webSearchResult(
  block: Anthropic.Messages.WebSearchToolResultBlock,
): ServerToolResultBlock {
  const wire = structuredClone(block);
  if (!Array.isArray(block.content)) {
    return {
      type: "server_tool_result",
      toolUseId: block.tool_use_id,
      name: "web_search",
      results: [],
      error: block.content.error_code,
      wire,
    };
  }
  return {
    type: "server_tool_result",
    toolUseId: block.tool_use_id,
    name: "web_search",
    results: block.content.map((r) => ({
      title: r.title,
      url: r.url,
      ...(r.page_age === null || r.page_age === undefined ? {} : { age: r.page_age }),
    })),
    wire,
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
    case "pause_turn":
      return "pause_turn";
    default:
      return "other";
  }
}

function fromWireUsage(usage: Anthropic.Messages.Usage): Usage {
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    ...(searches > 0 ? { webSearches: searches } : {}),
  };
}

export interface AnthropicBatchClientOptions extends AnthropicClientOptions {
  /** Waits between status checks, in ms; the last one repeats. Default: 5 s, 10 s, 20 s, then 30 s. */
  pollMs?: readonly number[];
}

/** The Batch API's default waits between status checks. */
export const BATCH_POLL_MS: readonly number[] = [5_000, 10_000, 20_000, 30_000];

/**
 * The Anthropic Message Batches API as a model client (0.7): each request goes out as a batch of
 * one, at 50% of the token price. The client waits until the batch ends (usually minutes, at most
 * 24 hours), then gives the result as one response. No streaming: the text comes all at once.
 * An abort cancels the batch. A result that failed with an overload or an API error is thrown as
 * a transient error, so the loop sends the request again.
 */
export class AnthropicBatchClient implements ModelClient {
  readonly serverTools = ["web_search"] as const;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly pollMs: readonly number[];

  constructor(options: AnthropicBatchClientOptions) {
    this.model = options.model;
    this.pollMs = options.pollMs ?? BATCH_POLL_MS;
    this.client =
      options.client ??
      new Anthropic(options.apiKey === undefined ? {} : { apiKey: options.apiKey });
  }

  async *stream(request: ModelRequest, options?: StreamOptions): AsyncIterable<ModelEvent> {
    const signal = options?.signal;
    const params = toWireParams(
      this.model,
      request,
    ) as Anthropic.Messages.MessageCreateParamsNonStreaming;
    const batch = await this.client.messages.batches.create(
      { requests: [{ custom_id: "garuda", params }] },
      signal === undefined ? {} : { signal },
    );
    try {
      for (let i = 0; ; i++) {
        await wait(this.pollMs[Math.min(i, this.pollMs.length - 1)] ?? 30_000, signal);
        const state = await this.client.messages.batches.retrieve(batch.id);
        if (state.processing_status === "ended") break;
      }
    } catch (error) {
      // An abort (Ctrl-C, a finish-by time): stop the batch, so it costs nothing more.
      await this.client.messages.batches.cancel(batch.id).catch(() => undefined);
      throw error;
    }
    const results = await this.client.messages.batches.results(batch.id);
    for await (const item of results) {
      if (item.custom_id !== "garuda") continue;
      const result = item.result;
      if (result.type === "succeeded") {
        const response = fromWireMessage(result.message);
        const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        if (text !== "") yield { type: "text_delta", text };
        yield { type: "response", response };
        return;
      }
      if (result.type === "errored") {
        const detail = result.error.error;
        throw Object.assign(new Error(`Batch request failed: ${detail.message}`), {
          error: result.error,
        });
      }
      throw new Error(`The batch request was ${result.type}.`);
    }
    throw new Error("The batch ended without a result.");
  }
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
