/**
 * Provider-neutral model types (N1).
 * The loop, the session and the tools use only these types.
 * An adapter maps them to and from one provider's wire format.
 */

export interface TextBlock {
  type: "text";
  text: string;
  /**
   * The provider's citations of server tool results (0.6: Claude's web search), sent back
   * unchanged. Garuda reads only `url` and `title` from them.
   */
  citations?: unknown[];
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

/**
 * A tool call that the provider runs on its own servers (0.6: Claude's web search). Garuda does
 * not run it; it shows it and sends `wire` (the provider's block) back unchanged.
 */
export interface ServerToolUseBlock {
  type: "server_tool_use";
  id: string;
  name: string;
  input: unknown;
  wire: unknown;
}

/** The result of a server tool call. `wire` holds encrypted content that must go back unchanged. */
export interface ServerToolResultBlock {
  type: "server_tool_result";
  toolUseId: string;
  name: string;
  /** For the user and for other providers: the pages found. */
  results: { title: string; url: string; age?: string }[];
  /** An error code from the provider, for example "max_uses_exceeded". */
  error?: string;
  wire: unknown;
}

export type AssistantBlock = TextBlock | ToolUseBlock | ServerToolUseBlock | ServerToolResultBlock;

export type ContentBlock = AssistantBlock | ToolResultBlock;

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

/** A tool that the provider runs itself (0.6). Clients that cannot run it ignore it. */
export interface ServerToolSpec {
  type: "web_search";
  /** At most this many searches per request. */
  maxUses: number;
  /** Only these domains, or never these domains (not both). */
  allowedDomains?: readonly string[];
  blockedDomains?: readonly string[];
}

export interface ModelRequest {
  system: string;
  messages: readonly Message[];
  tools: readonly ToolSpec[];
  /** Tools that the provider runs (0.6). Only for clients that list them in `serverTools`. */
  serverTools?: readonly ServerToolSpec[];
  maxTokens: number;
}

/** "pause_turn" (0.6): a long server tool call paused; send the conversation again to go on. */
export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "pause_turn"
  | "other";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Server web searches (0.6), billed per search. */
  webSearches?: number;
}

export interface ModelResponse {
  content: AssistantBlock[];
  stopReason: StopReason;
  usage: Usage;
  /** The share of the token price that this response costs (0.7: 0.5 through the Batch API). */
  priceFactor?: number;
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
  /** The server tools this client can send (0.6). Absent: none. */
  readonly serverTools?: readonly ServerToolSpec["type"][];
  stream(request: ModelRequest, options?: StreamOptions): AsyncIterable<ModelEvent>;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  const searches = (a.webSearches ?? 0) + (b.webSearches ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    ...(searches === 0 ? {} : { webSearches: searches }),
  };
}
