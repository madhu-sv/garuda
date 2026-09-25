# Runtime and agent loop (`src/app/`, `src/loop/`)

## Runtime (`app/runtime.ts`)

`Runtime` holds everything one Garuda process needs. The CLI and the eval runner share it; it never
imports the CLI.

### Options

| Option | Meaning |
| --- | --- |
| `root`, `modelId` | Working root (real path) and model id. |
| `model` | A `ModelClient` or a function that loads one on first use (N3). |
| `modelInfo`, `maxTokens` | Context window and price of the model (default: the Claude table), and the output limit. The CLI gets them from `resolveModel`. |
| `approver`, `store` | Approval UI and session store. |
| `resume` | `true` (latest) or a session id. |
| `settings` | Default: read `.garuda/settings.json`. |
| `onEvent`, `onNotice` | Agent events; warnings outside tool calls. |
| `mcp` | `false`, or `{ home, env }` to override where MCP config and trust are read. |
| `hooks` | `false`, or `{ home }`. |

### `Runtime.create`

1. Load settings. `createExecutor(settings.executor)` → executor and an optional notice.
2. Load MCP configs and hooks configs (problems go to `onNotice`).
3. `buildSystemPrompt(root, GARUDA.md, memory.md, { codeIndex, sandboxed, mcp, web, hooks })`.
4. Build the tool registry (`defaultTools` with the code index mode and web options), limits (max steps,
   token budget, context window from settings or the model table), the price, the permission engine.
5. With `resume`, rebuild the session from its records.

### `runTurn(prompt, signal)`

1. `startHooks` (once): user hooks; project hooks after consent (hash in `trust.json`).
2. `startMcp` (once): load the MCP manager with `import()`, start servers, register their tools.
   A Ctrl-C during the start clears the state, so the next turn tries again.
3. `ensureSession()`: a new session with a `start` record, or the current one.
4. `addUserMessage(session, prompt, mcp.takeNotes())`.
5. Load the model if it is still a factory, then `runAgent(session, deps)`.

Other methods: `newSession()`, `recordStop(reason)`, `mcpStatus()`, `hookLines()`, `close()` (closes MCP
clients).

## Agent loop (`loop/runAgent.ts`)

```ts
runAgent(session, deps): Promise<AgentResult>
deps: { model, tools, system, permissions, executor?, knowledge?, hooks?,
        maxTokens?, maxSteps?, tokenBudget?, contextWindow?, price?, signal?, onEvent? }
```

Algorithm:

```text
tools = deps.tools.specs()          # once per run: same bytes every request (N2)
closeOpenToolCalls(session)         # a crash can leave tool_use without tool_result
while steps < maxSteps:
  if session tokens >= budget: stop token_budget
  compactIfNeeded(session)          # see context.md
  steps += 1
  response = stream(system, messages, tools, maxTokens)   # emits text_delta
  addAssistantResponse(session, response, cost)
  calls = tool_use blocks
  if none: stop done | max_tokens | refusal (from the model stop reason)
  results = runTools(calls)         # see below
  addToolResults(session, results, meta)
  if the last 3 call signatures are equal: stop repeated_calls
stop max_steps
```

`runTools`: consecutive read-only calls run in parallel (`Promise.all`); other calls run one at a
time, in order. Results keep the call order. Each result meta records the executor name and isolation
for calls that run commands (N8).

Events: `text_delta`, `tool_call`, `tool_result`, `compaction`, `step_end`.

Defaults: `DEFAULT_MAX_STEPS = 50`, `DEFAULT_MAX_TOKENS = 8192`, `DEFAULT_TOKEN_BUDGET = 20 000 000`,
`REPEAT_LIMIT = 3`.

## Replay (`loop/replay.ts`)

`replaySession(records, tools)` plays a recorded session with no API calls:

- A `FakeModelClient` returns the recorded assistant responses in order.
- `RecordedTools` returns the recorded tool results by call id; it uses the real tool list only for
  definitions and read-only flags.
- For each recorded user message (with Garuda's note blocks kept as recorded), `runAgent` runs with the
  recorded limits, and the result must match: stop reason, step count, the conversation, and the tool
  calls. Interrupted runs end the replay.

## Tests

`test/loop.test.ts`, `test/limits.test.ts`, `test/parallel.test.ts`, `test/sessions.test.ts` (replay),
the milestone acceptance tests, and `test/mcp.test.ts` / `test/hooks.test.ts` for runtime integration.
