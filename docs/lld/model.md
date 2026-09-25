# Model adapter (`src/model/`)

## Purpose

Give the loop one provider-neutral interface for model calls (N1), with prompt caching (N2),
costs, and a fake model for tests (N4). Since 0.3, Garuda talks to Anthropic and to any server with
an OpenAI-compatible Chat Completions API: local servers (Ollama, LM Studio, llama.cpp, vLLM) and
hosted open models (OpenRouter).

## Why no orchestration framework

Frameworks such as LangChain or LlamaIndex were considered and rejected. The `ModelClient` interface
already gives the decoupling; a new provider is one adapter file. A framework would hide the details an
agent must control (cache breakpoints, streaming, tool-call formats, stop reasons), add a large dependency
tree against N3 and the single binary, and LlamaIndex targets retrieval, not tool-calling loops.

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

- The only module that imports `@anthropic-ai/sdk`. `ResolvedModel.create()` loads it with `import()` on
  the first model call, so startup does not pay for it.
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

## Providers (`providers.ts`)

A model spec is `<provider>/<model>`, or a plain Claude model id for the default provider `anthropic`.
The model part may hold `/` (OpenRouter ids): the spec splits at the first `/`.

| Provider | Type | Base URL | Key | Price |
| --- | --- | --- | --- | --- |
| `anthropic` | anthropic | SDK default | `ANTHROPIC_API_KEY` (SDK) | Garuda's table |
| `ollama` | openai-compatible | `http://localhost:11434/v1` | none | 0 (local) |
| `lmstudio` | openai-compatible | `http://localhost:1234/v1` | none | 0 (local) |
| `llamacpp` | openai-compatible | `http://localhost:8080/v1` | none | 0 (local) |
| `vllm` | openai-compatible | `http://localhost:8000/v1` | none | 0 (local) |
| `openrouter` | openai-compatible | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | unknown unless set |

`~/.garuda/models.json` adds or replaces providers and describes models:

```json
{
  "providers": {
    "lab": { "type": "openai-compatible", "baseUrl": "https://llm.example.com/v1", "apiKeyEnv": "LAB_KEY" }
  },
  "models": {
    "ollama/qwen3-coder:30b": { "contextWindow": 65536, "maxTokens": 8192 },
    "ollama/qwen2.5-coder:7b": { "contextWindow": 32768, "textToolCalls": "lines" },
    "openrouter/qwen/qwen3-coder": { "price": { "input": 0.2, "output": 0.8, "cacheRead": 0, "cacheWrite": 0 } }
  }
}
```

`resolveModel(spec, config)` returns the provider, the model name, the provider definition, the model
info (context window, price), `maxTokens`, notes for the user, and `create()`, which loads the adapter
with `import()` on first use (N3). `create()` passes the model's `textToolCalls` mode to the
OpenAI-compatible adapter (the Anthropic adapter does not need it).

Security rules:

- Only the user's own `~/.garuda/models.json` can define a provider. A project's settings cannot set a
  base URL: a cloned repository could otherwise send the code and an API key to its own server. (Project
  settings may still set `model.price` and `model.contextWindow`, which are harmless.)
- API keys come only from environment variables (`apiKeyEnv`), never from files.
- A base URL must be http(s) and hold no user name or password. Plain http is allowed only to this
  machine, unless the provider sets `"allowInsecureHttp": true` (for a trusted network).
- A missing key fails with "Set <VAR> to use the <provider> provider."

Context windows: an open model with no `contextWindow` entry gets 32 768 tokens, and Garuda says so.
The small default makes compaction start early. The server must allow the window too: Ollama picks a
default by the GPU memory (4k below 24 GiB); set `OLLAMA_CONTEXT_LENGTH`.

## OpenAI-compatible adapter (`openaiCompatible.ts`)

- `fetch` and server-sent events; no SDK. Request: `POST <baseUrl>/chat/completions` with `model`,
  `messages`, `tools` (omitted when empty), `max_tokens`, `stream: true`,
  `stream_options: { include_usage: true }`, and `Authorization: Bearer <key>` when there is a key.
- Messages: the system prompt first; a user message with tool results becomes one `tool` message per
  result (linked by `tool_call_id`), then a user message with the text blocks (Garuda's notes stay);
  assistant tool calls become `tool_calls` with JSON arguments.
- Stream: text deltas go to the live view; tool-call deltas are joined by index (name and argument parts
  can arrive in pieces); a missing call id gets a generated one. Broken argument JSON stays a string, so
  the tool's input check rejects it and the model can try again.
- Tool calls written as text (`textToolCalls.ts`): some small models (for example `qwen2.5-coder`
  through Ollama) write a call as JSON in the message text, not in `tool_calls`. When the server sent
  no real calls and the output was not cut at `length`, the adapter reads such calls under the model's
  `textToolCalls` mode (set per model in `models.json`):

  | Mode | Rule | Use it for |
  | --- | --- | --- |
  | `whole` (default) | The whole reply is one or more calls; nothing else. | Most models. |
  | `lines` | Calls stand on their own lines (or in their own fence or tag) between lines of prose. The prose stays text. | A model that explains before and after it calls. |
  | `off` | Text is always text. | A model that shows JSON examples often. |

  Accepted forms: `{"name", "arguments" | "parameters"}` objects, alone, one per line, over several
  lines, in a JSON array, in ```` ```json ```` fences or in `<tool_call>` tags. Rules in every mode:
  every name is a tool of this request and arguments are a JSON object. In `whole` mode, if one part
  fails, all the text stays text. In `lines` mode, a line that fails stays text; a call in the middle
  of a sentence never runs; a fence of another language (```` ```python ````) stays text as a whole.
  These calls get no extra power: the input check, hooks and the permission engine apply as usual.
- Held text (`StreamHold`): text that can still be a call (`mayBeToolCall`: it starts with `{`, `[`, a
  fence or the tag) is held back from the screen. In `whole` mode the adapter holds the reply until its
  start rules a call out; in `lines` mode it shows each line at once and holds from the first line that
  can start a call. At the end it shows the held text without the calls. The session stores real
  `tool_use` blocks, so the model sees proper `tool_calls` in the history.
- Stop reasons: refusal or `content_filter` → refusal; tool calls → tool_use; `length` → max_tokens;
  `stop` → end_turn.
- Usage: `prompt_tokens` minus `cached_tokens` is input, `cached_tokens` is cache read. A server that
  sends no usage gets an estimate (4 characters per token), so context tracking and compaction still work.
- Errors: two retries for 408, 409, 429 and 5xx (with `Retry-After` up to 30 s) and for network errors;
  "Cannot reach <provider> at <url>. Is the server running?" for a refused connection; a context-length
  error adds a hint to set `contextWindow`. Ctrl-C aborts the request.
- No cache breakpoints: the API has none. The system prompt and tool list keep the same bytes, so servers
  with automatic prefix caching (vLLM, llama.cpp) reuse them.

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
with a fake SDK response), `test/providers.test.ts` (specs, presets, `models.json`, URL rules, message
mapping, a local fake Chat Completions server: split chunks, tool calls, tool calls written as text,
held text, `lines` mode set in `models.json`, usage, retries, errors, and a whole Garuda turn),
`test/textToolCalls.test.ts` (the accepted forms in each mode, every rule that keeps text as text, and
`StreamHold`).
