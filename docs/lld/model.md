# Model adapter (`src/model/`)

## Purpose

Give the loop one provider-neutral interface for model calls (N1), with prompt caching (N2),
costs, and a fake model for tests (N4).

## Types (`types.ts`)

```ts
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
interface Message { role: "user" | "assistant"; content: ContentBlock[] }
interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
interface ModelRequest { system: string; messages: Message[]; tools: ToolSpec[]; maxTokens: number }
interface ModelResponse { content: (TextBlock | ToolUseBlock)[]; stopReason: StopReason; usage: Usage }
interface Usage { inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens }
type ModelEvent = { type: "text_delta"; text } | { type: "response"; response: ModelResponse };

interface ModelClient {
  stream(request: ModelRequest, options?: { signal?: AbortSignal }): AsyncIterable<ModelEvent>;
}
```

The loop, the session and the tools use only these types.

## Anthropic adapter (`anthropic.ts`)

- The only module that imports `@anthropic-ai/sdk`. The CLI loads it with `import()` on the first model
  call, so startup does not pay for it.
- `stream()` calls `messages.stream`, yields each `text_delta`, then yields the final message as a
  `ModelResponse`. The abort signal goes to the SDK.
- Mapping functions are pure and exported for tests: `toWireParams`, `toWireTools`, `toWireMessage`,
  `fromWireMessage`. Block types that Garuda does not use (thinking, server tools) are dropped.

### Prompt caching (N2)

Three cache breakpoints (`cache_control: ephemeral`):

1. On the system prompt.
2. On the last tool definition: the whole tool list is cached.
3. On the last block of the last message: the conversation so far is cached; the next request reads it.

This works because the system prompt and the tool list stay the same bytes for a whole session:
the registry sorts tools by name, the loop computes specs once per run, and new facts from `remember`
load only in the next session. Note: a model caches a prompt only above its minimum size (for example
4096 tokens for Haiku 4.5), so short sessions show "0 cached".

## Prices and windows (`pricing.ts`)

- `lookupModel(id)`: the longest matching model-id prefix wins (so `claude-opus-5-5` does not fall back
  to `claude-opus-5`). Unknown models get a 200k window and no price (cost shows as unknown).
- Settings override: `model.price` (USD per million tokens: input, output, cacheRead, cacheWrite) and
  `model.contextWindow`.
- `costOf(usage, price)`, `totalTokens(usage)`, `contextSize(usage)` (input + cache read + cache write +
  output of the last response: the size of the context now).

## Fake model (`fake.ts`)

`FakeModelClient(steps)` plays a script. A step is a `ModelResponse` or a function of the request (so a
test can assert what the model received). It records every request and throws `ScriptExhaustedError`
when the script ends. Builders: `text()`, `toolUse()`, `reply()`.

## Tests

`test/model.test.ts` (mapping, cache breakpoints, prices), `test/anthropic-stream.test.ts` (streaming
with a fake SDK response).
