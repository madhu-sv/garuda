import type {
  AssistantBlock,
  ModelClient,
  ModelEvent,
  ModelRequest,
  ModelResponse,
  ServerToolSpec,
  StopReason,
  StreamOptions,
  TextBlock,
  ToolUseBlock,
  Usage,
} from "./types.js";

/**
 * One scripted step. A fixed response, or a function of the request
 * (so a test can check what the loop sent before it answers).
 */
export type ScriptStep = ModelResponse | ((request: ModelRequest) => ModelResponse);

export class ScriptExhaustedError extends Error {
  constructor(calls: number) {
    super(`Fake model script has no step for call ${calls}.`);
    this.name = "ScriptExhaustedError";
  }
}

/**
 * A model client that plays back a script (N4).
 * It makes no network calls. It records every request it gets.
 */
export class FakeModelClient implements ModelClient {
  readonly requests: ModelRequest[] = [];
  /** Server tools the fake accepts, like a Claude model (0.6). Default: none. */
  readonly serverTools?: readonly ServerToolSpec["type"][];
  private readonly steps: ScriptStep[];

  constructor(steps: ScriptStep[], options: { serverTools?: ServerToolSpec["type"][] } = {}) {
    this.steps = [...steps];
    if (options.serverTools !== undefined) this.serverTools = options.serverTools;
  }

  get remaining(): number {
    return this.steps.length;
  }

  async *stream(request: ModelRequest, options?: StreamOptions): AsyncIterable<ModelEvent> {
    options?.signal?.throwIfAborted();
    // Copy the request, so later changes to the session do not change the record.
    this.requests.push(structuredClone(request));
    const step = this.steps.shift();
    if (step === undefined) throw new ScriptExhaustedError(this.requests.length);
    const response = typeof step === "function" ? step(request) : step;

    for (const block of response.content) {
      if (block.type === "text") yield { type: "text_delta", text: block.text };
    }
    yield { type: "response", response };
  }
}

// Small builders, so scripts stay short and readable.

const FAKE_USAGE: Usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function text(value: string): TextBlock {
  return { type: "text", text: value };
}

let nextToolUseId = 1;

export function toolUse(name: string, input: unknown, id?: string): ToolUseBlock {
  return { type: "tool_use", id: id ?? `toolu_fake_${nextToolUseId++}`, name, input };
}

export function reply(
  content: AssistantBlock[],
  stopReason?: StopReason,
  usage: Usage = FAKE_USAGE,
): ModelResponse {
  const reason =
    stopReason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  return { content, stopReason: reason, usage };
}
