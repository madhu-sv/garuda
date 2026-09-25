import { extractTextToolCalls, StreamHold, type TextToolCallMode } from "./textToolCalls.js";
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

/**
 * The OpenAI-compatible adapter (0.3): the Chat Completions API that Ollama, LM Studio,
 * llama.cpp, vLLM and OpenRouter serve. It uses fetch and server-sent events, with no SDK.
 * Mapping functions are pure and exported for tests.
 *
 * Differences from the Anthropic adapter:
 * - No cache breakpoints: the API has none. The system prompt and the tool list still keep the
 *   same bytes (N2), so servers with automatic prefix caching reuse them.
 * - Tool results become "tool" messages; the tool call id links them.
 * - A server that sends no usage gets an estimate (4 characters per token), so compaction still works.
 * - Some small models write a tool call as JSON text. Under the model's "textToolCalls" mode it
 *   becomes a real call (see textToolCalls.ts). While streamed text can still be one, the adapter
 *   holds it back from the screen.
 */

export interface OpenAICompatibleOptions {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** How to read tool calls that the model writes as text. Default "whole". */
  textToolCalls?: TextToolCallMode;
  /** For tests. */
  fetch?: typeof fetch;
  /** Waits before retry 1 and 2, in ms. */
  retryDelaysMs?: readonly number[];
}

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAYS = [1_000, 4_000];
const MAX_RETRY_AFTER_MS = 30_000;

export class OpenAICompatibleClient implements ModelClient {
  private readonly fetch: typeof fetch;
  private readonly delays: readonly number[];

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.fetch = options.fetch ?? fetch;
    this.delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
  }

  async *stream(request: ModelRequest, options?: StreamOptions): AsyncIterable<ModelEvent> {
    const http = await this.post(toWireBody(this.options.model, request), options?.signal);
    const mode = request.tools.length === 0 ? "off" : (this.options.textToolCalls ?? "whole");
    const state = newStreamState();
    // Holds back text while it can still be a tool call written as text.
    const hold = new StreamHold(mode);
    for await (const data of sseData(http.body as ReadableStream<Uint8Array>, options?.signal)) {
      if (data === "[DONE]") break;
      let chunk: WireChunk;
      try {
        chunk = JSON.parse(data) as WireChunk;
      } catch {
        continue;
      }
      if (chunk.error !== undefined)
        throw new Error(`${this.options.provider}: ${errorText(chunk.error)}`);
      const shown = hold.push(applyChunk(state, chunk));
      if (shown !== "") yield { type: "text_delta", text: shown };
    }
    const response = finishResponse(state, request, mode);
    // Show the held text, without the parts that became tool calls.
    const held = hold.rest();
    if (held !== "") {
      const became = response.content.some((b) => b.type === "tool_use") && state.calls.size === 0;
      const shown = became
        ? (extractTextToolCalls(held, toolNames(request), mode)?.text ?? held)
        : held;
      if (shown.trim() !== "") yield { type: "text_delta", text: shown };
    }
    yield { type: "response", response };
  }

  private async post(body: unknown, signal: AbortSignal | undefined): Promise<Response> {
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
    };
    if (this.options.apiKey !== undefined) headers.authorization = `Bearer ${this.options.apiKey}`;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        const cause = causeCode(error);
        if (attempt < this.delays.length && cause !== "ECONNREFUSED") {
          await sleep(this.delays[attempt] ?? 1_000, signal);
          continue;
        }
        throw new Error(
          cause === "ECONNREFUSED"
            ? `Cannot reach ${this.options.provider} at ${this.options.baseUrl}. Is the server running?`
            : `${this.options.provider}: ${(error as Error).message}`,
        );
      }
      if (response.ok && response.body !== null) return response;
      const text = (await response.text().catch(() => "")).slice(0, 500);
      if (RETRY_STATUS.has(response.status) && attempt < this.delays.length) {
        const retryAfter = Number(response.headers.get("retry-after")) * 1_000;
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, MAX_RETRY_AFTER_MS)
            : (this.delays[attempt] ?? 1_000);
        await sleep(wait, signal);
        continue;
      }
      throw new Error(
        `${this.options.provider} answered ${response.status}: ${httpErrorText(text)}`,
      );
    }
  }
}

// Wire types (the parts Garuda uses).

type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface WireChunk {
  choices?: {
    delta?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  } | null;
  error?: unknown;
}

export function toWireBody(model: string, request: ModelRequest): Record<string, unknown> {
  return {
    model,
    messages: toWireMessages(request.system, request.messages),
    ...(request.tools.length === 0 ? {} : { tools: toWireTools(request.tools) }),
    max_tokens: request.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
}

export function toWireTools(tools: readonly ToolSpec[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

/**
 * Garuda's messages to Chat Completions messages. A user message with tool results becomes one
 * "tool" message per result (in order), then a user message with any text blocks.
 */
export function toWireMessages(system: string, messages: readonly Message[]): WireMessage[] {
  const out: WireMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "assistant") {
      const text = message.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const calls = message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      out.push({
        role: "assistant",
        content: text === "" ? null : text,
        ...(calls.length === 0
          ? {}
          : {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }),
      });
      continue;
    }
    const texts: string[] = [];
    for (const block of message.content) {
      if (block.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: block.toolUseId,
          content: block.isError
            ? `Error: ${block.content.replace(/^Error: /, "")}`
            : block.content,
        });
      } else if (block.type === "text") {
        texts.push(block.text);
      }
    }
    if (texts.length > 0) out.push({ role: "user", content: texts.join("\n\n") });
  }
  return out;
}

// Stream state.

interface StreamState {
  text: string;
  refusal: string;
  calls: Map<number, { id?: string; name: string; args: string }>;
  finish: string | undefined;
  usage: WireChunk["usage"];
}

function newStreamState(): StreamState {
  return { text: "", refusal: "", calls: new Map(), finish: undefined, usage: undefined };
}

/** Apply one chunk; return the new text for the live view. */
export function applyChunk(state: StreamState, chunk: WireChunk): string {
  if (chunk.usage) state.usage = chunk.usage;
  const choice = chunk.choices?.[0];
  if (choice === undefined) return "";
  if (choice.finish_reason) state.finish = choice.finish_reason;
  const delta = choice.delta ?? {};
  if (delta.refusal) state.refusal += delta.refusal;
  for (const [position, call] of (delta.tool_calls ?? []).entries()) {
    const index = call.index ?? position;
    const entry = state.calls.get(index) ?? { name: "", args: "" };
    if (call.id) entry.id = call.id;
    if (call.function?.name) entry.name += call.function.name;
    if (call.function?.arguments) entry.args += call.function.arguments;
    state.calls.set(index, entry);
  }
  const text = delta.content ?? "";
  state.text += text;
  return text;
}

export function finishResponse(
  state: StreamState,
  request: ModelRequest,
  mode: TextToolCallMode = "whole",
): ModelResponse {
  const content: (TextBlock | ToolUseBlock)[] = [];
  const text = state.text + (state.refusal === "" ? "" : state.refusal);
  // Some local servers send no id: make one, so results can refer to it.
  const newId = (n: number) => `call_${Date.now().toString(36)}_${n}`;
  const fromText =
    state.calls.size === 0 && state.refusal === "" && state.finish !== "length"
      ? extractTextToolCalls(text, toolNames(request), mode)
      : undefined;
  if (fromText !== undefined) {
    if (fromText.text !== "") content.push({ type: "text", text: fromText.text });
    for (const [i, call] of fromText.calls.entries())
      content.push({ type: "tool_use", id: newId(i + 1), name: call.name, input: call.input });
  } else if (text !== "") {
    content.push({ type: "text", text });
  }
  let n = 0;
  for (const [, call] of [...state.calls.entries()].sort(([a], [b]) => a - b)) {
    if (call.name === "") continue;
    n++;
    content.push({
      type: "tool_use",
      id: call.id ?? newId(n),
      name: call.name,
      input: parseArguments(call.args),
    });
  }
  return {
    content,
    stopReason: stopReason(state, content),
    usage: usageOf(state, request, content),
  };
}

function toolNames(request: ModelRequest): Set<string> {
  return new Set(request.tools.map((t) => t.name));
}

/**
 * Tool arguments as JSON. Broken JSON (common with small models) stays a string, so the
 * tool's input check rejects it and the model sees why and can try again.
 */
export function parseArguments(args: string): unknown {
  if (args.trim() === "") return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function stopReason(state: StreamState, content: readonly ContentBlock[]): StopReason {
  if (state.refusal !== "" || state.finish === "content_filter") return "refusal";
  if (content.some((b) => b.type === "tool_use")) return "tool_use";
  if (state.finish === "length") return "max_tokens";
  if (state.finish === "stop" || state.finish === undefined || state.finish === "tool_calls")
    return "end_turn";
  return "other";
}

function usageOf(
  state: StreamState,
  request: ModelRequest,
  content: readonly ContentBlock[],
): Usage {
  const u = state.usage;
  if (u?.prompt_tokens !== undefined) {
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      inputTokens: Math.max(0, u.prompt_tokens - cached),
      outputTokens: u.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
  }
  // No usage from the server: estimate, so context tracking and compaction still work.
  const chars = (value: unknown) => JSON.stringify(value).length;
  return {
    inputTokens: Math.ceil(
      (request.system.length + chars(request.messages) + chars(request.tools)) / 4,
    ),
    outputTokens: Math.ceil(chars(content) / 4),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** The "data:" payloads of a server-sent event stream. */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const reader = body.getReader();
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length > 0) yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
        newline = buffer.indexOf("\n");
      }
    }
    if (data.length > 0) yield data.join("\n");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    signal?.throwIfAborted();
  }
}

/** The network error code; with IPv4 and IPv6 tried, undici wraps the codes in an AggregateError. */
function causeCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string; errors?: { code?: string }[] } }).cause;
  return cause?.code ?? cause?.errors?.find((e) => e.code !== undefined)?.code;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" ? message : JSON.stringify(error).slice(0, 300);
}

/** A readable error; hint at the context window when the server says the prompt is too long. */
function httpErrorText(body: string): string {
  let message = body;
  try {
    message = errorText((JSON.parse(body) as { error?: unknown }).error ?? body);
  } catch {
    // Not JSON: keep the text.
  }
  const hint = /context|too long|maximum.*tokens|num_ctx/i.test(message)
    ? " (The conversation may be larger than the model's context window. Set contextWindow for this model in ~/.garuda/models.json.)"
    : "";
  return `${message}${hint}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
