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
| `profiles` | Language profiles; default: detected from the root (see [languages.md](languages.md)). |
| `mode` | `build` (default) or `plan` for the first turn (0.4; `--plan`). |
| `commands` | `false`, or `{ home }` for custom slash commands (0.4). |
| `subagentModel` | `{ spec, model, info }` for the explore subagent; default: the main model (see [agents.md](agents.md)). |
| `skills` | `{ home? }` (0.5): skills from `~/.garuda/skills`, `~/.claude/skills` and the project. Absent: no skills (tests, evals). The CLI passes it; `skills.enabled: false` in settings wins. See [skills.md](skills.md). |
| `agents` | `{ home?, resolveModel? }` (0.5): custom agents from the four agent folders; `resolveModel` turns a model id of a user agent into a client (the CLI passes its provider lookup). Absent: no agents. `agents.enabled: false` wins. See [agents.md](agents.md). |
| `search` | `{ config, fetch? }` (0.5): the web search backend that the CLI loaded from `~/.garuda/search.json` or the environment. Absent: no `web_search`. `web.enabled: false` wins. See [web.md](web.md). |
| `undo` | `{ home? }` (0.4): snapshots before each turn in `~/.garuda/snapshots`. Absent: no snapshots. The CLI passes it; `undo.enabled: false` in settings wins. See [undo.md](undo.md). |
| `lsp` | `{ enabled?, home?, path?, firstTimeoutMs?, timeoutMs? }` (0.4). `enabled` overrides `lsp.enabled` from settings (`--lsp`, evals); `home` holds `~/.garuda/lsp.json` and the managed servers; `path` is the PATH to search. See [lsp.md](lsp.md). |

### `Runtime.create`

1. Load settings. `createExecutor(settings.executor)` → executor and an optional notice.
2. Load MCP configs and hooks configs (problems go to `onNotice`).
3. Detect the language profiles. `buildSystemPrompt(root, GARUDA.md, memory.md, { codeIndex, sandboxed,
   mcp, web, hooks, languages, explore, todo, lsp })`.
4. Build the tool registry (`defaultTools` with the code index mode and web options), limits (max steps,
   token budget, context window from settings or the model table), the price, the permission engine
   (with the profiles' cache access), and — only with `subagents.enabled: true` — the explore tool with
   its own read-only registry.
5. With LSP on, read `~/.garuda/lsp.json` (`autoInstall`; a broken file is a notice).
6. With `resume`, rebuild the session from its records.

### `runTurn(prompt, signal)`

0. The turn's mode is fixed: `turnMode = selectedMode` (0.4). With LSP on and a Maven or Gradle profile,
   jdtls starts now in the background (`LspManager.warm("java")`), because its project import is slow. `setMode()` during a turn applies to the
   next one; the permission engine reads `turnMode`.
1. `startHooks` (once): user hooks; project hooks after consent (hash in `trust.json`).
2. `startMcp` (once): load the MCP manager with `import()`, start servers, register their tools.
   A Ctrl-C during the start clears the state, so the next turn tries again.
3. `ensureSession()`: a new session with a `start` record, or the current one. With undo on, a snapshot
   of the files and a `snapshot` record (a failure turns undo off with a notice).
4. `attachMentions(prompt, root, session.files)` (0.6, `app/mentions.ts`): each `@path` that is a file or
   folder in the root becomes a text block (a file numbered like read_file, ≤ 2 000 lines, recorded as read so
   `edit_file` works at once; a folder as its entry list, ≤ 200). Sensitive, binary, too large (10 MB) and
   outside-root paths are skipped with a reason; at most 10 attachments and 150 000 characters. A `notice`
   event tells the user what was attached.
5. `addUserMessage(session, prompt, notes, attachments)`: in plan mode the first note is `PLAN_NOTE` (what plan mode
   allows, and to end with a numbered plan), then the pending notes (undo, `!command` output) and the MCP
   notes; the attachments follow as plain text blocks. The system prompt is the same in both
   modes, so the prompt cache stays valid (N2).
6. Load the model if it is still a factory (`client()`), then
   `runAgent(session, deps)`. With LSP on, `deps.diagnostics` calls the `LspManager`, which the runtime
   creates with `import()` on the first edit (N3).

Other methods: `newSession()`, `recordStop(reason)`, `mcpStatus()`, `hookLines()`, `close()` (closes MCP
clients and language servers), `mode` and `setMode()` (0.4), `commands` and `resolveCommand()` (0.4),
`lspEnabled`, `lspStatus()` and `installLsp()` (0.4), `runUserCommand(command, signal)` (0.6: a `!command` from the chat runs through `tools.execute` as a
`bash` call, so the permission engine, hooks and executor apply; the output, cut at 10 000 characters and
with Garuda's markers neutralized, goes into `pendingNotes` for the next message), `agents` and `allowAgent()` (0.5: custom agents; see [agents.md](agents.md)), `skills` and `allowSkill()` (0.5: the consent for a
project skill; `resolveCommand` checks skills before custom commands; see [skills.md](skills.md)), `init(signal)` (0.5: loads `init/run.js` with `import()`, runs the migration and git steps with the runtime's approver and executor, and returns the report and the init prompt; see [init.md](init.md)).

Sessions and models in the chat (0.6):

- `listSessions(max = 20)`: `store.list()` and a `summariseSession` (from `session/list.ts`) for each:
  first prompt line, prompts, model, cost.
- `switchSession(ref)`: `resumeSession` for a number from the list, an id, or the unique start of an id;
  it writes a `resume` record, drops the pending notes, and says how full the context is.
- `sessionRecords()`: the current session's records, for `/export`.
- `modelList()`: `knownModels()` from `pricing.ts`, then the specs of `~/.garuda/models.json` that resolve
  (option `models.configured`); the main model is always in the list.
- `setModel(ref)`: a number, an alias (`aliasModel`) or a spec. `options.models.resolve(spec)` gives the
  client (created at once, so a missing API key shows now), the window, price and `maxTokens`. Settings
  (`contextWindow`, `price`) still override. It writes a `model` record with the new start fields. `modelId`,
  `limits` and `price` are getters, so the footer, `/usage`, agents without a model and the next turn use the
  new values. Explore without `--subagent-model` keeps the start model (its own client of `options.model`).
  The system prompt does not change (N2), but the provider's prompt cache is per model, so the next request
  writes the cache again.

## Agent loop (`loop/runAgent.ts`)

```ts
runAgent(session, deps): Promise<AgentResult>
deps: { model, tools, system, permissions, executor?, knowledge?, hooks?, diagnostics?,
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
  response = stream(system, messages, tools, maxTokens)   # emits text_delta; retried, see below
  addAssistantResponse(session, response, cost)
  calls = tool_use blocks
  if none: stop done | max_tokens | refusal (from the model stop reason)
  results = runTools(calls)         # see below
  addToolResults(session, results, meta)
  for each call with a subagent report: add its usage and cost to the session and the run
  if the last 3 call signatures are equal: stop repeated_calls
stop max_steps
```

`runTools`: consecutive read-only calls run in parallel (`Promise.all`); other calls run one at a
time, in order. Results keep the call order. Each result meta records the executor name and isolation
for calls that run commands (N8), and the subagent report for explore calls. Each call gets its own
`callId` and `progress` callback in the tool context.

Model retries (0.3): when a response stream breaks with a transient error (`isTransientModelError` in
`model/errors.ts`: a closed connection such as undici's `terminated`, a reset or timeout, a 5xx or 529
status, an `overloaded_error` in the stream), the loop sends the same request again after 1 s, then 4 s
(`retryDelaysMs`), and emits `model_retry`. It never retries a 4xx error, a refused connection to a local
server, or a user abort; Ctrl-C during the wait stops at once. The session gets only the complete
response, so a retry never leaves half a message in the record. The SDKs retry only before a stream
starts; this covers the break in the middle.

Events (the runtime adds `notice`, 0.6: a line for the user, for example the attached files): `text_delta`, `tool_call`, `tool_progress` (a one-line status of a long call, for example a
subagent's current step), `tool_result`, `model_retry` (attempt, max retries, delay, reason), `compaction`,
`step_end` (the step's usage and, since 0.5, the full `response`).

`AgentResult`: `stopReason`, `steps`, `usage` (this run, subagents included), `apiMs` (time in model calls,
retries included; 0.5) and `modelStopReason` (the last response's stop reason; 0.5). The JSON output of
`-p` uses the last three (see [cli.md](cli.md)).

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

`test/loop.test.ts`, `test/limits.test.ts`, `test/parallel.test.ts`, `test/retry.test.ts` (transient
errors, retries, give-up, no retry for 4xx, Ctrl-C during the wait, notices), `test/sessions.test.ts` (replay),
the milestone acceptance tests, and `test/mcp.test.ts` / `test/hooks.test.ts` for runtime integration.
