# Editors over ACP (`src/acp/`, 0.15, planned)

Status: design. The core change (patch 2: `callId` in approval questions) is built; the rest is not
yet. The plan and the scope of the first iteration are at the end.

## Purpose

`garuda acp` runs Garuda as an agent for code editors that speak the Agent Client Protocol (ACP):
Zed, JetBrains IDEs, Neovim (CodeCompanion), Emacs (agent-shell) and others. The editor starts
`garuda acp` as a child process and talks JSON-RPC 2.0 over its stdin and stdout. The editor shows
the conversation, the tool calls and the approval questions; Garuda keeps doing all the work.

The rule for this component: **ACP is a new front end, not a new trust model.** The same permission
engine, OS sandbox, team policy, hooks and audit log apply as in the terminal. The editor only
shows and answers; it never runs a command or writes a file for Garuda.

## Protocol version and library

- ACP protocol version 1 (the stable one). Version 2 is still marked experimental; Garuda does not
  offer it.
- The official TypeScript SDK `@agentclientprotocol/sdk` (Apache-2.0, Zed Industries). It gives the
  types, the zod schemas of every message, and the stdio framing (`ndJsonStream`). Its only peer
  dependency is zod, which Garuda already has. The version is pinned in `package.json`.
- The SDK is imported only by `garuda acp`, so the startup time of the other commands (N3) does not
  change.
- Methods and fields that the schema marks **UNSTABLE** are not used.

## Files

| File | Role |
| --- | --- |
| `src/cli/acpCommand.ts` | The `garuda acp` command: model and policy setup (as for the chat), stdout guard, start the server. |
| `src/acp/server.ts` | The ACP agent: `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/set_mode`. One `Runtime` per ACP session. |
| `src/acp/approver.ts` | `AcpApprover`: an `Approver` that asks with `session/request_permission`. |
| `src/acp/updates.ts` | Maps `AgentEvent`s to `session/update` notifications (text, thoughts, tool calls). |
| `src/acp/prompt.ts` | Turns the editor's content blocks into Garuda's prompt text. |
| `src/acp/toolCalls.ts` | Title, kind, locations and diff content of a tool call. |

## Process and stdout

The editor starts `garuda acp` in the project folder (or another folder; `session/new` gives the
working root). Stdout carries only protocol messages: one JSON object per line.

- Before anything else, the command keeps the real stdout for the protocol and redirects
  `process.stdout.write` to stderr. A notice, a warning or a library that prints to stdout then
  goes to stderr and cannot break the protocol stream. Editors show stderr in their logs.
- The model comes from `--model` or `GARUDA_MODEL`, the providers from `~/.garuda/models.json`, the
  keys from the environment: the same rules as the terminal. The editor's agent settings pass the
  environment (for example `ANTHROPIC_API_KEY`).
- The provider keys leave Garuda's environment at startup (`keepProviderKey`), as in the terminal.
- The team policy loads from the managed file and `~/.garuda/policy.json`, never from the project.
- When stdin closes (the editor stops the agent), every runtime closes and every executor shuts
  down, so no command keeps running.

## Sessions

| ACP | Garuda |
| --- | --- |
| `session/new { cwd, mcpServers }` | `Runtime.create({ root: cwd, … })`: a new runtime with its own executor, permission engine, approvals for the session, undo snapshots and audit log. |
| `sessionId` | A new id that maps to that runtime. The Garuda session file starts at the first prompt, as in the chat. |
| Several sessions | Several runtimes in one process. Each has its own executor (0.14.1), so one session's end does not stop another's commands. |

- `cwd` must be an absolute path to a folder. Else `session/new` fails with a clear error.
- A missing model or key makes `session/new` fail with the message that the terminal would show
  ("Set a model with --model <id> or the GARUDA_MODEL variable."). The editor shows it.
- Project settings that loosen safety (0.14, `projectSettings`) need a yes. The editor cannot answer
  a question about a session before `session/new` has returned, so in the first iteration the ACP
  session uses only settings that the user already approved in a terminal (pinned in
  `~/.garuda/trust.json`). Unapproved ones are ignored with a notice that says how to approve them:
  run `garuda` once in that folder.

## Initialize

The answer to `initialize`:

```json
{
  "protocolVersion": 1,
  "agentInfo": { "name": "garuda", "title": "Garuda", "version": "0.15.0" },
  "agentCapabilities": {
    "loadSession": false,
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
    "mcpCapabilities": { "http": false, "sse": false }
  },
  "authMethods": []
}
```

- No `authMethods`: the keys come from the environment, as in the terminal.
- The client's `fs` and `terminal` capabilities are read but not used (see "What Garuda does not
  give to the editor").

## A prompt turn

`session/prompt { sessionId, prompt: ContentBlock[] }`:

1. Only one prompt per session at a time. A second one gets an error while the first runs.
2. `prompt.ts` makes the prompt text:
   - `text` → the text.
   - `resource_link` to a `file://` path → `@<path relative to the root>`, so Garuda's mention code
     attaches the file with its normal permission check (a denied file is not attached, with a
     notice). A link outside the root or not a file stays as text: the name and the URI.
   - `resource` (embedded context, for example a selection) → a fenced block with its URI as the
     label. It is text that the user sent, like a paste.
   - `image` and `audio` are not offered, so the editor does not send them.
3. A prompt that starts with `/` goes through `Runtime.resolveCommand`: custom commands and skills
   work. A built-in chat command (`/undo`, `/diff` …) gets an answer that it is only in the terminal
   in this version.
4. `Runtime.runTurn(prompt, signal)` runs the turn. Its events become `session/update`
   notifications (below).
5. The response is `{ stopReason }`:

| Garuda | ACP `stopReason` |
| --- | --- |
| `done` | `end_turn` |
| `max_tokens` | `max_tokens` |
| `refusal` | `refusal` |
| `max_steps`, `token_budget`, `repeated_calls` | `max_turn_requests` |
| the signal was aborted (`session/cancel`) | `cancelled` |

A model or provider error ends the request with a JSON-RPC error that carries the message, and the
runtime records the stop (`recordStop("error")`), as the terminal does.

## Events to `session/update`

| `AgentEvent` | `session/update` |
| --- | --- |
| `text_delta` | `agent_message_chunk` (text) |
| `thinking_delta` | `agent_thought_chunk` (text) |
| `tool_call` | `tool_call` with `status: "pending"`, a title, a kind, locations and `rawInput` |
| `tool_result` | `tool_call_update` with `status: "completed"` or `"failed"` and the result text as content |
| `tool_progress` | `tool_call_update` with `status: "in_progress"` and the progress line as content |
| `server_tool` (Claude's web search) | `tool_call` with kind `fetch`, then its result |
| `notice`, `compaction`, `model_retry` | `agent_message_chunk` with a short line that starts with "Garuda:" |
| `step_end` | nothing in the first iteration |

- A denied call ends as `failed`, with the reason as content.
- After `model_retry`, the text of the broken stream is void in Garuda, but the editor has already
  shown it. The notice line says that the answer starts again; the old text stays on screen. This is
  a limit of streaming over ACP.

Tool kinds and titles (`toolCalls.ts`):

| Tool | `kind` | Title |
| --- | --- | --- |
| `read_file` | `read` | `Read <path>` |
| `glob`, `grep`, code index tools | `search` | `Search <pattern>` |
| `write_file`, `edit_file` | `edit` | `Write <path>`, `Edit <path>` |
| `bash`, `process_manager` | `execute` | `$ <command>` |
| `web_fetch`, `web_search` | `fetch` | `Fetch <url>`, `Search the web: <query>` |
| subagents (`explore`, custom agents, experts) | `think` | `Subagent: <name>` |
| `todo` | `think` | `Update the plan` |
| MCP tools and others | `other` | `<server>/<tool>` or the tool name |

Every title and every text that comes from the model or a file goes through `visible()` from
`src/cli/approver.ts`: control, invisible and bidirectional characters become visible (0.14.1). A
title is one line.

`locations` holds the absolute path (and the line, when the input has one) of path tools, so the
editor can follow the agent.

## Approvals

`AcpApprover.ask(request, signal)` sends `session/request_permission` and waits.

- **Which tool call.** Read-only calls run in parallel (F8), so "the last tool call" is not a safe
  guess. A small core change passes the tool call id: the registry gives `callId` in the
  `PermissionRequest`, and the engine puts it in the `ApprovalRequest`. The question then names the
  right `toolCallId`. A question that is not about a tool call (an MCP server consent, a hook
  consent, the network allowlist, a skill or agent consent) gets its own `toolCallId` with kind
  `other`.
- **The question.** `toolCall.title` is the request's title (or the tool call's title).
  `toolCall.content` is the preview as text. For `write_file` and `edit_file`, the content is also an
  ACP `diff` (`path`, `oldText`, `newText`), so the editor shows its own diff view: `newText` comes
  from the tool input (the new content, or the replacement applied to the current file). If that
  fails, only the text preview is sent.
- **Hidden characters.** The preview goes through `visible()`, and `hasHidden()` adds the warning
  line, as in the terminal (0.14.1 high finding). An editor must not show a command that looks like
  another one.
- **The options** follow the request's `choices` and `labels`:

| Garuda choice | `optionId` | `kind` | Default name |
| --- | --- | --- | --- |
| `once` | `once` | `allow_once` | Allow once |
| `session` | `session` | `allow_always` | Allow for this session |
| `deny` | `deny` | `reject_once` | Deny |

  "Always" in Garuda means this session only (session rules), as in the terminal. The name says so.
- **The answer.** `selected` with a known `optionId` → that choice. `cancelled`, an unknown id, or an
  error → `deny`. When the turn's signal aborts, the approver answers `deny` at once and does not
  wait for the editor.
- **Hunks.** Accepting single hunks (U0) is a terminal feature. Over ACP, an edit is accepted or
  denied as a whole.

## Cancel

`session/cancel { sessionId }` aborts the turn's `AbortController`. The running command stops (the
executor kills its process group), a waiting approval answers `deny`, and `session/prompt` returns
`{ stopReason: "cancelled" }`. The next prompt closes the open tool call first
(`closeOpenToolCalls`), as after Ctrl-C.

## Modes

Garuda's agent modes become ACP session modes:

```json
"modes": {
  "currentModeId": "build",
  "availableModes": [
    { "id": "build", "name": "Build", "description": "Edits and commands, each one asks first." },
    { "id": "plan", "name": "Plan", "description": "Reads and plans. No edits; commands cannot write the project." }
  ]
}
```

`session/set_mode` calls `runtime.setMode`. The mode applies from the next turn, as in the terminal.

## Commands

After `session/new`, Garuda sends `available_commands_update` with its custom commands and skills
(name, description, argument hint). The editor shows them when the user types `/`.

## What Garuda does not give to the editor

- **Files and commands stay in Garuda.** The editor offers `fs/read_text_file`,
  `fs/write_text_file` and `terminal/*`. Garuda does not use them in this version: reads and writes go
  through Garuda's path checks and undo snapshots, and commands run in Garuda's OS sandbox. If the
  editor ran them, the sandbox and the policy would not apply. A consequence: Garuda reads the saved
  file, not the editor's unsaved buffer.
- **MCP servers from the editor are not started.** `session/new` can list MCP servers from the
  editor's configuration. In the first iteration Garuda does not start them (the capabilities say
  `http: false`, `sse: false`; stdio servers in the list are ignored too) and shows a notice with their
  names. Garuda's own `~/.garuda/mcp.json` and the project's servers work as in the terminal, with
  their consents.

## Security

| Risk | Answer |
| --- | --- |
| The editor or a plugin in it sends prompts | The editor is the user's own program, like the terminal. Every tool call still passes the permission engine, the sandbox and the team policy. |
| A command that looks like another one in the editor's approval view | `visible()` and the warning line, as in the terminal. |
| Output on stdout breaks the protocol, or hides a fake message in it | stdout is redirected to stderr; only the SDK writes protocol messages. |
| An editor MCP server runs code outside Garuda's consent | Not started in the first iteration. |
| Project settings loosen safety without a yes | Only settings already approved in a terminal apply. |
| Commands keep running after the editor closes | stdin end → all runtimes close, all executors shut down; the exit handler kills the rest. |

The audit log records the same events as in the terminal.

## Tests (planned)

All tests run in one process with the SDK's client side over paired streams and Garuda's
`FakeModelClient`, with temporary homes and roots (no network, no API key):

- `initialize`: protocol version 1 and the capabilities above.
- `session/new` with a relative `cwd` fails; with no model it fails with the terminal's message.
- A prompt streams `agent_message_chunk`s and returns `end_turn`.
- A tool call: `tool_call` then `tool_call_update` with `completed`; titles and kinds.
- An edit asks with `session/request_permission` for the right `toolCallId`, with a `diff`; `once`
  writes the file; `deny` does not, and the call ends `failed`.
- Two parallel read-only calls that both ask (two `web_fetch`) get questions with their own ids.
- `session` (allow_always) answers the next same call with no question.
- A preview with a carriage return or an escape sequence arrives with visible characters and the
  warning line.
- `session/cancel` during a question and during a command: `cancelled`, no file written, the
  command is gone, and the next prompt works.
- A second prompt while one runs gets an error.
- `session/set_mode` to `plan`: an edit is denied.
- `resource_link` to a file in the root attaches it; one outside the root does not.
- `/name` runs a custom command.
- Process test: `node dist/cli/index.js acp` with a notice-producing setup writes only JSON-RPC lines
  on stdout.

Each fix-like rule (the stdout guard, the call id, visible characters) gets a test that fails
without it.

## Editor setup (for the user guide)

Zed, in `settings.json`:

```json
{
  "agent_servers": {
    "Garuda": {
      "type": "custom",
      "command": "garuda",
      "args": ["acp"],
      "env": { "GARUDA_MODEL": "claude-sonnet-5", "ANTHROPIC_API_KEY": "…" }
    }
  }
}
```

Other ACP editors take the same three things: the command `garuda`, the argument `acp`, and the
environment. The user guide will have the steps for each editor that we test.

## Scope of the first iteration (0.15.0)

In scope:

1. `garuda acp` over stdio, ACP version 1, with the SDK.
2. `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/set_mode`.
3. Streaming of text, thoughts and tool calls; tool kinds, titles and locations.
4. Approvals with `session/request_permission`: the right tool call id (core change), ACP diff for
   edits, hidden characters made visible, consents as questions.
5. Build and plan modes; custom commands and skills in `available_commands_update`.
6. Prompts with text, file links and embedded context.
7. The stdout guard and the clean shutdown.
8. Tests as above; the user guide with the Zed setup; a live test in Zed on macOS.

Not in the first iteration (candidates for the second):

- `session/load`, `session/list`, `session/resume`: Garuda's session history in the editor (needs a
  replay of the session as updates).
- The model choice in the editor (`configOptions` and `session/set_config_option`).
- `usage_update` (tokens and cost) and `session_info_update` (the session title).
- MCP servers from the editor, with Garuda's consent.
- The editor's unsaved buffers through `fs/read_text_file` (read only, through Garuda's path checks).
- Built-in chat commands (`/undo`, `/diff`, `/compact` …) over ACP.
- Images in prompts.
- Hunk-by-hunk approval.
- Questions about project settings at `session/new`.

Never (by design): commands through the editor's terminal, writes through the editor's file system.

## Plan

| Patch | Content | Check |
| --- | --- | --- |
| 1 | This design document. | Review. |
| 2 | Core: `callId` from the registry through `PermissionRequest` to `ApprovalRequest`. No change of behaviour. | A test that the approver gets the id of each parallel call. |
| 3 | `src/acp/` and `garuda acp`: server, approver, updates, prompt, tool calls; the SDK dependency. | The tests above. |
| 4 | Docs: user guide (editor setup), README, site, architecture (a new front end and its trust boundary), CHANGELOG. | Live test in Zed on macOS: chat, an edit with the diff view, a denied command, cancel, plan mode. |
| 5 | Release 0.15.0. | `pnpm check`, CI, the release workflow. |
