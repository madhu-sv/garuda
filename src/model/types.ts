/**
 * Provider-neutral model types (N1).
 * The loop, the session and the tools use only these types.
 * An adapter maps them to and from one provider's wire format.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/** A tool definition as the model sees it. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: readonly Message[];
  tools: readonly ToolSpec[];
  maxTokens: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelResponse {
  content: Array<TextBlock | ToolUseBlock>;
  stopReason: StopReason;
  usage: Usage;
}

/** Events that a model client streams while it generates one response. */
export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "response"; response: ModelResponse };

export interface StreamOptions {
  signal?: AbortSignal;
}

/**
 * The one interface to a model provider (N1).
 * `stream` yields zero or more `text_delta` events and then exactly one `response` event.
 */
export interface ModelClient {
  stream(request: ModelRequest, options?: StreamOptions): AsyncIterable<ModelEvent>;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
