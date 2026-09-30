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
type AssistantBlock = TextBlock | ToolUseBlock | ServerToolUseBlock | ServerToolResultBlock | ThinkingBlock;
interface ThinkingBlock { type: "thinking"; text: string; wire: unknown }   // 0.9
type ContentBlock = AssistantBlock | ToolResultBlock;
interface TextBlock { type: "text"; text: string; citations?: unknown[] }   // citations: 0.6
interface Message { role: "user" | "assistant"; content: ContentBlock[] }
interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
interface ServerToolSpec { type: "web_search"; maxUses; allowedDomains?; blockedDomains? }   // 0.6
interface ModelRequest { system; messages: Message[]; tools: ToolSpec[]; serverTools?: ServerToolSpec[]; maxTokens; thinking?: ThinkingRequest }
interface ThinkingRequest { adaptive?: boolean; display?: "summarized" | "omitted"; effort?: Effort }   // 0.9
interface ModelResponse { content: AssistantBlock[]; stopReason: StopReason; usage: Usage }
type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn" | "other";
interface Usage { inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; webSearches? }
type ModelEvent = { type: "text_delta"; text } | { type: "thinking_delta"; text } | { type: "response"; response: ModelResponse };

interface ModelClient {
  readonly serverTools?: ServerToolSpec["type"][];   // what the provider can run itself (0.6)
  stream(request: ModelRequest, options?: { signal?: AbortSignal }): AsyncIterable<ModelEvent>;
}
```

Server tool blocks (0.6) keep the provider's block in `wire`, which goes back unchanged; `results` and
`error` are a neutral view for display, compaction and other providers (`serverTools.ts`). See
[web.md](web.md).

Thinking blocks (0.9) work the same way. Claude Opus 5.5, Opus 5, Sonnet 5, Fable 5 and 5.1 and Mythos 5
and 5.1 always think (the API refuses `thinking: disabled`), and by default they return the thinking
as an empty text with an encrypted `signature`. The API asks for every thinking block back, unchanged,
within a tool-use turn; without them the model loses its earlier reasoning between steps. Garuda
before 0.9 dropped them. Now `ThinkingBlock.wire` holds the `thinking` or `redacted_thinking` block and
goes back byte for byte; `text` is the readable thinking (empty when omitted or redacted). They are left
out (`thinking.ts`, `withoutThinking`) only where they cannot go back unchanged: after `/models` (a
signature belongs to its model), on a resume with another model, and when redaction changed one on
disk. The compaction summary, `/export` and the OpenAI-compatible adapter ignore them. The setting
`thinking.keepBlocks: false` (and `garuda eval --keep-thinking off`) drops them as before, for A/B runs.

`/thinking` (0.9) sends `ModelRequest.thinking`. `ModelInfo.thinking` in `pricing.ts` says per model:
`always` (the 5-series) or `optional` (Opus 4.6 to 4.8, Sonnet 4.6), and the effort levels (4.6 has no
`xhigh`). `thinkingRequest(choice, caps)` builds the fields: `effort` → `output_config.effort`;
`adaptive` or `display` → `thinking: { type: "adaptive", display? }` (a display alone is never sent to
an optional model, because it would turn thinking on). No choice sends nothing, as before 0.9. When
thinking is asked for, `max_tokens` is at least 16,384 (32,000 for `xhigh` and `max`), because thinking
counts toward it. Since 0.12 this also holds for a model that always thinks with no choice set, and a
cut-off response is recovered (see runtime-and-loop.md, "Output limit"). With `display: "summarized"` the adapter streams `thinking_delta` events.

The loop, the session and the tools use only these types.

## Anthropic adapter (`anthropic.ts`)

- The only module that imports `@anthropic-ai/sdk`. `ResolvedModel.create()` loads it with `import()` on
  the first model call, so startup does not pay for it.
- `stream()` calls `messages.stream`, yields each `text_delta`, then yields the final message as a
  `ModelResponse`. The abort signal goes to the SDK.
- Mapping functions are pure and exported for tests: `toWireParams`, `toWireTools`, `toWireMessage`,
  `fromWireMessage`. `serverTools = ["web_search"]` (0.6): `toWireTools` adds `web_search_20250305`;
  `server_tool_use`, `web_search_tool_result` and text citations map to Garuda's blocks and back unchanged;
  `pause_turn` and `usage.server_tool_use` map too. `thinking` and `redacted_thinking` (0.9) map to
  `ThinkingBlock` and back unchanged.

### Batch API (`AnthropicBatchClient`, 0.7)

The same mapping as the streaming client; each `stream()` call sends one request as a batch
(`messages.batches.create`, `custom_id: "garuda"`), checks its status (5 s, 10 s, 20 s, then every 30 s),
and reads the result when the batch has ended. It yields the whole text as one `text_delta`, then the
response. A `succeeded` result maps like a normal message. An `errored` result throws an error that
carries the API error, so an overload or API error is transient and the loop sends the request again;
`canceled` and `expired` are not transient. An abort cancels the batch. Each status check has a 60 s time limit, and a failed
check is tried again (10 failures in a row fail the request), so a check that hangs after sleep cannot
block a job. `onWait` gets the batch id when a batch starts and a status line about every minute.
`ResolvedModel.createBatch(env, { onWait })` exists
only for the Anthropic provider. Each batch response carries `priceFactor: 0.5`; `responseCost` (the loop,
compaction, child runs) prices tokens at that factor and web searches at full price.

Measured (basic suite, claude-sonnet-5, 10 tasks at a time, one run each): normal API $0.217, 78% of tokens
from the cache, 23 s; Batch API $0.100, 81%, 33 min (about 3 minutes per step). The next day a single
batch stayed in progress for more than 6 hours: the wait is uneven.

`DeadlineClient` (`deadline.ts`) wraps a slow, cheap client and a fast one: requests go to the first until a
switch time; a request still waiting then is cancelled and sent to the second, and so are all later ones.
With `stepLimitMs`, a request that waits longer goes to the fast client for that request only
(`calls.slow`). The user's abort is never a switch. Scheduled jobs on the Batch API use it (see
[jobs.md](jobs.md)).

### Prompt caching (N2)

Three cache breakpoints (`cache_control: ephemeral`):

1. On the system prompt.
2. On the last tool definition: the whole tool list is cached.
3. On the last block of the last message: the conversation so far is cached; the next request reads it.
   A thinking block takes no mark (0.9): the mark goes on the last other block.

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
- Messages: the system prompt first; Claude's search blocks (after `/models`) become text with the titles
  and URLs (0.6); a user message with tool results becomes one `tool` message per
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
- `knownModels()` (0.6): the table, newest first, for `/models`.
- `costOf(usage, price)` adds `WEB_SEARCH_USD` ($0.01) per Claude web search (0.6); `totalTokens(usage)`, `contextSize(usage)` (input + cache read + cache write +
  output of the last response: the size of the context now).

## Fake model (`fake.ts`)

`FakeModelClient(steps)` plays a script. A step is a `ModelResponse` or a function of the request (so a
test can assert what the model received). It records every request and throws `ScriptExhaustedError`
when the script ends. Builders: `text()`, `toolUse()`, `reply()`.

## Transient errors (`errors.ts`)

`isTransientModelError(error)` says whether the same request can succeed on a new attempt. It reads plain
properties (name, code, status, message, `error.type`, `cause`, `AggregateError.errors`), so it needs no
SDK (N1). Transient: `APIConnectionError`, reset and timeout codes (`ECONNRESET`, `ETIMEDOUT`,
`UND_ERR_SOCKET` …), status 500/502/503/504/529, `overloaded_error` or `api_error` in the stream, and
messages such as `terminated` or "socket hang up". Never transient: a 4xx status, an abort, and Garuda's
own errors such as "Cannot reach … Is the server running?". `errorReason(error)` gives a short reason
for the notice. The agent loop uses both (see [runtime-and-loop.md](runtime-and-loop.md)).

## Tests

`test/claudeSearch.test.ts` (0.6: server search mapping, cost), `test/thinking.test.ts` (0.9: mapping,
the loop with and without `keepThinking`, redaction, resume, `/models`), `test/model.test.ts` (mapping, cache breakpoints, prices), `test/anthropic-stream.test.ts` (streaming
with a fake SDK response), `test/providers.test.ts` (specs, presets, `models.json`, URL rules, message
mapping, a local fake Chat Completions server: split chunks, tool calls, tool calls written as text,
held text, `lines` mode set in `models.json`, usage, retries, errors, and a whole Garuda turn),
`test/textToolCalls.test.ts` (the accepted forms in each mode, every rule that keeps text as text, and
`StreamHold`).
