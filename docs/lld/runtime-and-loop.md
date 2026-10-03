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
| `settings` | Default: read `.garuda/settings.json`, gated by `projectSettings`. |
| `projectSettings` | `{ home?, ask? }` (review 2026-10): the parts of the project's settings that loosen safety apply only when pinned in `home`/.garuda/trust.json or approved at startup (`ask`, the CLI with a terminal). Absent: they are left out with a notice. See [permissions.md](permissions.md). |
| `onEvent`, `onNotice` | Agent events; warnings outside tool calls. |
| `mcp` | `false`, or `{ home, env }` to override where MCP config and trust are read. |
| `hooks` | `false`, or `{ home }`. |
| `profiles` | Language profiles; default: detected from the root (see [languages.md](languages.md)). |
| `mode` | `build` (default) or `plan` for the first turn (0.4; `--plan`). |
| `commands` | `false`, or `{ home }` for custom slash commands (0.4). |
| `subagentModel` | `{ spec, model, info }` for the explore subagent; default: the main model (see [agents.md](agents.md)). |
| `skills` | `{ home? }` (0.5): skills from `~/.garuda/skills`, `~/.claude/skills` and the project. Absent: no skills (tests, evals). The CLI passes it; `skills.enabled: false` in settings wins. See [skills.md](skills.md). |
| `agents` | `{ home?, resolveModel? }` (0.5): custom agents from the four agent folders; `resolveModel` turns a model id of a user agent into a client (the CLI passes its provider lookup). Absent: no agents. `agents.enabled: false` wins. See [agents.md](agents.md). |
| `search` | `{ config?, claude?, fetch? }` (0.5; `claude` 0.6): the web search backend and Claude's search, as the CLI loaded them from `~/.garuda/search.json` or the environment. Absent: no `web_search`. `web.enabled: false` wins. See [web.md](web.md). |
| `unattended` | `{ reason, onDeny? }` (0.7): a scheduled job; the permission engine denies instead of asking. See [jobs.md](jobs.md). |
| `models` | `{ resolve, configured? }` (0.6): for `/models`; `resolve` turns a spec into `{ spec, model, info, maxTokens? }` (the CLI passes its provider lookup), `configured` lists the specs of `~/.garuda/models.json`. Absent: `/models` lists but cannot switch. |
| `undo` | `{ home? }` (0.4): snapshots before each turn in `~/.garuda/snapshots`. Absent: no snapshots. The CLI passes it; `undo.enabled: false` in settings wins. See [undo.md](undo.md). |
| `lsp` | `{ enabled?, home?, path?, firstTimeoutMs?, timeoutMs? }` (0.4). `enabled` overrides `lsp.enabled` from settings (`--lsp`, evals); `home` holds `~/.garuda/lsp.json` and the managed servers; `path` is the PATH to search. See [lsp.md](lsp.md). |

### `Runtime.create`

1. Load settings (`gateProjectSettings`: the loosening parts only when approved). `createExecutor(settings.executor)` → executor and an optional notice.
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
   allows, and to end with a numbered plan and, since 0.7, a `permissions` block for `/schedule`), then the pending notes (undo, `!command` output, 0.9: a stopped turn from `recordStop("interrupted")`) and the MCP
   notes; the attachments follow as plain text blocks. The system prompt is the same in both
   modes, so the prompt cache stays valid (N2).
6. Load the model if it is still a factory (`client()`), then
   `runAgent(session, deps)`. With LSP on, `deps.diagnostics` calls the `LspManager`, which the runtime
   creates with `import()` on the first edit (N3).

Other methods: `newSession()`, `recordStop(reason)`, `mcpStatus()`, `hookLines()`, `close()` (closes MCP
clients and language servers), `mode` and `setMode()` (0.4), `commands` and `resolveCommand()` (0.4),
`lspEnabled`, `lspStatus()` and `installLsp()` (0.4), `runUserCommand(command, signal)` (0.6: a `!command` from the chat runs through `tools.execute` as a
`bash` call, so the permission engine, hooks and executor apply; the output, cut at 10 000 characters and
with Garuda's markers neutralized, goes into `pendingNotes` for the next message; `newSession()` clears them, 0.14), `agents` and `allowAgent()` (0.5: custom agents; see [agents.md](agents.md)), `skills` and `allowSkill()` (0.5: the consent for a
project skill; `resolveCommand` checks skills before custom commands; see [skills.md](skills.md)), `init(signal)` (0.5: loads `init/run.js` with `import()`, runs the migration and git steps with the runtime's approver and executor, and returns the report and the init prompt; see [init.md](init.md)).

Sessions and models in the chat (0.6):

- `listSessions(max = 20)`: `store.list()` and a `summariseSession` (from `session/list.ts`) for each:
  first prompt line, prompts, model, cost.
- `switchSession(ref)`: `resumeSession` for a number from the list, an id, or the unique start of an id;
  it writes a `resume` record, drops the pending notes, and says how full the context is.
- `renameSession(ref, title)` and `deleteSession(ref, signal)` (0.8): the same refs as `switchSession`.
  The title is one line without control characters (`cleanTitle`, at most 60 characters). Delete asks
  (the preview has the title and turns), never takes the open session, and calls `store.remove`.
- `thinkingStatus()` and `setThinking(word)` (0.9): the `/thinking` choice for the main model; it goes to
  `runAgent` as `deps.thinking` (`thinkingRequest`), and `thinkingMaxTokens` raises `max_tokens`.
- `formatSource` (0.10): with `formatters.enabled` and an OS sandbox, the `format` dependency of the loop
  (see [format.md](format.md)).
- `runCheck(command, timeoutMs, signal)` and `askModel(system, text, signal)` (0.11, a job's proof of
  work): a command in the sandbox with bash's policy, outside the engine; one model request with no
  tools, the main model and its price, no session.
- `sessionRecords()`: the current session's records, for `/export`.
- `compact(focus, signal)` (0.8): `compactNow` on the current session with the main model and its price;
  the result has the tokens before and after and the summary's cost.
- `modelList()`: `knownModels()` from `pricing.ts`, then the specs of `~/.garuda/models.json` that resolve
  (option `models.configured`); the main model is always in the list.
- `lastPlan` and `scheduleJob(at, signal)` (0.7): the last plan-mode turn that ended `done` (its prompt, its
  last answer, the session); `/schedule` makes a job of it with `jobs/create.ts` (loaded with `import()`).
- `diff(scope, path, signal)`: `/diff` from the undo snapshots (see [undo.md](undo.md)).
- `notificationSettings`: the `notifications` setting, for the CLI's notifier.
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
        maxTokens?, maxSteps?, tokenBudget?, contextWindow?, price?, signal?, onEvent?, serverTools? }
```

Server tools (0.6): `usableServerTools(model, deps.serverTools)` keeps the ones the client can run; they go
in each request, and a client tool of the same name leaves the tool list. After each response the loop
emits a `server_tool` event per server call (with its result, when the response has it). A response with
`pause_turn` and no tool calls starts the next step at once (the paused message is last). Before each
turn, `Runtime.claudeSearchTools()` decides (asking once per session) whether Claude's search goes in.

Algorithm:

```text
tools = deps.tools.specs()          # once per run: same bytes every request (N2)
closeOpenToolCalls(session)         # a crash can leave tool_use without tool_result
while steps < maxSteps:
  if session tokens >= budget: stop token_budget
  compactIfNeeded(session)          # see context.md
  steps += 1
  response = stream(system, messages, tools, maxTokens)   # emits text_delta; retried, see below
  if response stopped at max_tokens and recoveries < 3:     # output limit (0.12)
    keep its text blocks only (a half tool call cannot run; thinking alone is no answer)
    addAssistantResponse(session, kept, cost); maxTokens = max(maxTokens, 32 000)
    addContinuation(session, "<garuda_note>…cut off… Go on…</garuda_note>")   # a `continue` record
    emit notice; next step
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

Output limit (0.12). A model that always thinks (the 5-series) spends its thinking from `max_tokens`, so
the runtime gives it `thinkingMaxTokens` also when no `/thinking` choice is set: 16,384 by default (was
8,192). A response that still hits the limit no longer ends the turn: the loop keeps its text, asks the
model to go on, and raises the limit to 32,000 (a larger configured limit stays), up to 3 times per run
(`MAX_OUTPUT_RECOVERIES`); the 4th cut-off stops with `max_tokens`. Its tokens and cost count. Found in
the repo eval live test: 1 of 9 runs stopped at step 3 with `max_tokens` after thinking alone.

Defaults: `DEFAULT_MAX_STEPS = 50`, `DEFAULT_MAX_TOKENS = 8192`, `DEFAULT_TOKEN_BUDGET = 20 000 000`,
`REPEAT_LIMIT = 3`.

## Core modularization (0.14)

In 0.14, the core agent loop and runtime coordinators were decomposed into cohesive single-responsibility modules:

- **Loop modularization (`src/loop/`):**
  - `runAgent.ts`: High-level loop orchestrator (< 300 lines).
  - `callModel.ts`: Model invocation, response streaming, server tools resolution, and transient error backoff retries.
  - `events.ts`: Structured agent lifecycle event dispatcher.
  - `limits.ts`: Step limit and token budget checks, context window exhaustion detection, and output-limit recovery.
  - `loopDetector.ts`: Repeated tool call detection preventing infinite loops.
  - `toolRunner.ts`: Tool execution pipeline, read-only call parallelization, progress tracking, and execution metadata capture.

- **Runtime coordinator extraction (`src/app/`):**
  - `modelState.ts` (`ModelState`): Dynamic model switching, pricing lookup, context window sizing, and `/thinking` controls.
  - `sessionManager.ts` (`SessionManager`): Session lifecycle, resume, rename, and permanent deletion.
  - `undoCoordinator.ts` (`UndoCoordinator`): Git-backed filesystem snapshotting before turns, `/undo`, `/redo`, and `/diff`.

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
