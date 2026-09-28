# High-level design

Version 0.8.0-dev. This document shows how the parts work together. The component documents in
[lld/](lld/) give the details.

## 1. Modes of use

| Command | Mode | Output |
| --- | --- | --- |
| `garuda` | Chat. Ink view on a terminal, plain lines otherwise. | Interactive. |
| `garuda -m ollama/qwen3-coder:30b` | Any mode with another provider (`<provider>/<model>`). | Same. |
| `garuda -p "task"`, `echo task \| garuda` | One task, then exit. | Model text on stdout, activity on stderr. Exit code 0 (done), 1 (error), 2 (a limit stopped the run) or 130 (Ctrl-C). |
| `garuda --resume [id]` | Continue the latest or a given session. | Chat or one task. |
| `garuda --replay <id\|file>` | Play a session back with recorded results. No API calls. | "matches" or a list of differences. |
| `garuda eval` | Run eval tasks in scratch folders; `--parallel n`, `--batch on` (0.7) for the Batch API. | A table and `report.json`. |
| `garuda run <job> [--at HH:MM] [-m model]` | Run a scheduled job (0.7): its plan, unattended, in its own worktree and branch. | The run's lines, then the job report (also in `.garuda/jobs/<id>.md`). |
| `garuda eval -s java` / `--prepare java` | Check the toolchain, then run the Java (or Python) suite; `--prepare` fills `~/.m2` once. | A hint when a toolchain is missing; otherwise the same report. |

## 2. Start of a process

```mermaid
sequenceDiagram
  participant CLI as cli/index.ts
  participant RT as Runtime.create
  participant FS as Files
  CLI->>FS: ~/.garuda/models.json
  CLI->>CLI: resolveModel(spec): provider, model, window, price
  CLI->>RT: root, model spec and info, approver, store, event target
  RT->>FS: .garuda/settings.json
  RT->>RT: createExecutor(auto|os|host)
  RT->>FS: marker files (pom.xml, build.gradle, pyproject.toml …)
  RT->>RT: language profiles: commands, notes, cache paths
  RT->>FS: AGENTS.md, CLAUDE.md, GARUDA.md, .garuda/memory.md
  RT->>FS: ~/.garuda/commands and .garuda/commands
  RT->>FS: ~/.garuda and .garuda: mcp.json, hooks.json
  RT->>RT: system prompt (fixed for the session)
  RT->>RT: tools, permission engine
  RT-->>CLI: runtime (+ executor notice)
  CLI->>CLI: -p: one turn / chat: Ink or plain REPL
```

The executor choice decides much of the behaviour: with an OS sandbox, commands run with no approval;
without one, every command asks. MCP servers and hooks start later, before the first turn, because
their consent questions need the chat UI.

## 3. One turn

```mermaid
sequenceDiagram
  participant U as User
  participant RT as Runtime
  participant L as runAgent
  participant M as ModelClient
  participant R as ToolRegistry
  RT->>RT: first turn only: hooks consent, MCP consent and start
  RT->>L: prompt + notes (servers that are off)
  loop until no tool calls or a limit
    L->>L: compaction if the context is above 80%
    L->>M: stream(system, messages, tools)
    M-->>U: text deltas (rendered live)
    M-->>L: final response (content, usage)
    L->>R: tool calls (read-only ones in parallel)
    R-->>L: results (in call order)
  end
  L-->>RT: stop reason, steps, usage
  RT-->>U: usage line, stop message
```

A stream that breaks in the middle (a closed connection, an overload) is sent again up to 2 times, with a
notice; the session keeps only the complete response.

Before the loop (0.6), the runtime attaches the files of `@path` mentions to the prompt (they count as
read), adds the pending notes (for example the output of a `!command`), and decides whether Claude's web
search goes into the requests (it asks once per session). A server search runs inside the model reply;
a reply that stops with `pause_turn` goes straight into the next step.

Stop reasons: `done`, `max_steps` (default 50), `token_budget` (default 20 M), `repeated_calls` (3
identical calls in a row), `max_tokens`, `refusal`. Ctrl-C aborts the turn and kills its commands; a
second Ctrl-C exits Garuda.

## 4. One tool call

Every tool call, built-in or MCP, goes through the same pipeline in `ToolRegistry.execute`. The
pipeline never throws: every failure becomes an error result that the model can read.

```mermaid
flowchart TD
  A[tool_use from the model] --> B{Known tool?}
  B -- no --> E1[Error result]
  B -- yes --> C[Validate input with Zod]
  C -- invalid --> E1
  C --> D["describe(): target and preview<br/>(path, command, URL or input)"]
  D --> H1{preToolUse hooks}
  H1 -- exit 2 or failure --> E2[Blocked by a hook]
  H1 -- pass --> P{Permission engine}
  P -- deny --> E3[Permission denied]
  P -- ask --> Q{User}
  Q -- deny --> E3
  Q -- once / session --> RUN
  P -- allow --> RUN[run the tool]
  RUN --> T[toText, isError]
  T --> H2[postToolUse hooks: maybe add feedback]
  H2 --> OUT[Result to the model]
```

### The explore subagent (0.3)

`explore` is a read-only tool, so it passes the same pipeline with no approval. Its `run` starts a
second agent loop with its own session and read-only tools. Details: [lld/agents.md](lld/agents.md).

```mermaid
sequenceDiagram
  participant Main as Main loop
  participant Reg as ToolRegistry
  participant Ex as explore tool
  participant Child as Child loop
  participant RO as Read-only tools
  Main->>Reg: explore(question)
  Reg->>Ex: run (after hooks and permission check)
  Ex->>Child: runAgent(child session, EXPLORE_SYSTEM, limits)
  loop up to 20 steps
    Child->>RO: glob, grep, read_file (same permissions and hooks)
    RO-->>Child: results
    Child-->>Main: tool_progress "step N · grep /x/"
  end
  Child-->>Ex: answer (a wrap-up call if a limit hit)
  Ex-->>Reg: answer + trailer, usage report
  Reg-->>Main: tool result, usage added to the session
```

### Diagnostics after an edit (0.4)

With LSP on, `edit_file` and `write_file` write the file, then ask the `LspManager` for the errors of that
file. The manager starts the language server on first use, in the OS sandbox. Details:
[lld/lsp.md](lld/lsp.md).

```mermaid
sequenceDiagram
  participant Tool as edit_file
  participant LM as LspManager
  participant Ex as Executor (sandbox)
  participant LS as Language server
  Tool->>Tool: write the file (atomic)
  Tool->>LM: diagnostics(path, text)
  opt first file of this language
    LM->>Ex: start(server, read-only project, no network)
    LM->>LS: initialize, initialized
  end
  LM->>LS: didOpen or didChange (full text)
  LS-->>LM: diagnostics (pull or publish)
  LM-->>Tool: "N errors in path …" or nothing
  Tool-->>Tool: result = "Edited path." + errors
```

## 5. Permission decision

```mermaid
flowchart TD
  S[Request: tool, read-only flag, target] --> A{Sensitive path<br/>and no allow rule names it?}
  A -- yes --> DENY[Deny]
  A -- no --> B{Write into .git/?}
  B -- yes --> DENY
  B -- no --> C{A deny rule matches?}
  C -- yes --> DENY
  C -- no --> PM{Plan mode and<br/>not read-only?}
  PM -- yes --> PD{Command in the sandbox,<br/>or allow rule for a URL or MCP tool?}
  PD -- yes --> ALLOW
  PD -- no --> DENY
  PM -- no --> D{Read-only tool?}
  D -- yes --> ALLOW[Allow]
  D -- no --> E{Command inside the OS sandbox?}
  E -- yes --> ALLOW
  E -- no --> F{Allow rule or session rule<br/>and not an unusual URL?}
  F -- yes --> ALLOW
  F -- no --> ASK[Ask: once, session, deny]
```

Plan mode (0.4) never asks: file writes, edits and `remember` are always denied, and a command runs
only in the OS sandbox, which then cannot write the project (temp folders and package caches only).

Rules use one syntax everywhere: `tool` or `tool(pattern)`. Patterns are globs for paths, wildcards
for commands (each part of `a && b | c` is checked), hosts for URLs, and a trailing `*` in the tool
name for MCP servers (`mcp__github__*`).

## 6. Where commands run

| Runs | Through | Sandbox | Approval |
| --- | --- | --- | --- |
| `bash` tool | `Executor.run` | Yes (writes only in root, temp, caches; no network; secrets unreadable) | None in the sandbox; always for `outside_sandbox: true` |
| Hooks | `Executor.run` | Yes; network only if the hook says so | Project hooks: consent once |
| MCP servers | `Executor.start` | Yes; network only if the server config says so | Project servers: consent once; every tool call asks unless a rule |
| Eval checks | `HostExecutor` | No (Garuda's own test commands) | None |

The executor is Seatbelt on macOS, bubblewrap on Linux, or the host when neither works (`auto`).

## 7. Sessions

Every change to the conversation goes through `session.ts`, which writes the same change to the
journal. So the file always matches memory.

```mermaid
flowchart LR
  L[Loop] -->|addUserMessage, addAssistantResponse, addToolResults| S[Session in memory]
  S -->|same record| J[Journal]
  J -->|redact| F[(.garuda/sessions/id.jsonl)]
  F -->|rebuildState| RS[--resume]
  F -->|FakeModel + recorded results| RP[--replay]
```

### Undo (0.4)

Before each turn, the runtime takes a snapshot of the files in a git store of Garuda's own
(`~/.garuda/snapshots`) and writes a `snapshot` record. `/undo` asks, restores the files to the last
snapshot and cuts the turn out of the messages (`undo` record); `/redo` does the reverse. Details:
[lld/undo.md](lld/undo.md).

`/diff` (0.6) compares the first snapshot of the session (or the last turn's, `/diff last`) with the files
now.

### Sessions, models and export in the chat (0.6)

`/sessions` lists the project's sessions from `SessionStore.list()`; `/sessions <n|id>` resumes one in the
same process; `/sessions rename` and `delete` (0.8) give one a title or delete it after a question. `/models` lists the known and configured models; `/models <ref>` switches the main model for
the next turns (`modelId`, window, price and client change together; a `model` record keeps it).
`/export` writes the session records as Markdown. `/compact [focus]` (0.8) summarises the older turns at
once, with the automatic compaction's summary step. Details: [lld/cli.md](lld/cli.md),
[lld/runtime-and-loop.md](lld/runtime-and-loop.md).

### Scheduled jobs (0.7)

`/schedule` turns the last finished plan into a job file with its own approval list (from the plan's
`permissions` block), after one question. `garuda run <id>` builds it later in a git worktree on the
branch `garuda/job-<id>`: the permission engine allows the list and denies (never asks) everything else,
then Garuda commits the changes on the branch and writes a report. On macOS, `/schedule HH:MM` can add a
launchd agent that starts the run with nobody at the terminal and removes itself after it. With a Claude
model, a job can use the Batch API at half price: a step that waits more than its limit (20 minutes) runs on
the normal API, and from 15 minutes before the finish-by time (07:00) the whole job does. Details:
[lld/jobs.md](lld/jobs.md).

### Custom agents (0.5)

When agent files exist, the runtime registers the `agent` tool. A call runs a child session (shared with
explore, `agents/child.ts`) with the agent's instructions and tools, through the same permission engine,
hooks and executor, and returns a short report. A project agent asks at its first use. Details:
[lld/agents.md](lld/agents.md).

### Skills (0.5)

At start, the runtime reads skill folders (`~/.garuda/skills`, `~/.claude/skills`, `.garuda/skills`,
`.claude/skills`). When at least one exists, it registers the `skill` tool, whose description lists each
skill's name and description, and adds two lines to the system prompt. The model loads a skill with the tool;
the user runs one with `/name`. A project skill asks at its first load. Details: [lld/skills.md](lld/skills.md).

### JSON output (0.5)

With `-p --output-format json` the CLI prints one `result` line at the end; with `stream-json` it prints
`system/init`, then an `assistant` line per model response and a `user` line per tool result, then the
`result`. The field names are Claude Code's. A `JsonOutput` renderer takes the agent events, so the loop
does not change; stdout holds only JSON. Details: [lld/cli.md](lld/cli.md).

### Web search (0.5)

`web_search` is a normal tool. It calls the user's backend (Brave, Tavily or SearXNG, configured only in
the home folder), after a question that shows the query. Results come back as untrusted text; the model
reads pages with `web_fetch`. Claude's own search (0.6) is a server tool: the Anthropic adapter sends it,
the API runs it inside the reply, and its blocks go back unchanged; the chat asks once per session, and
the other backend is the fallback. Details: [lld/web.md](lld/web.md).

### Init (0.5)

`garuda init` starts the chat with `/init` as the first line. `/init` reads other agents' files (no
model), shows a preview and writes new files only after one yes; it offers `git init`; then it runs an
init turn whose prompt depends on the folder: read the code and write `AGENTS.md`, or ask what to build.
Details: [lld/init.md](lld/init.md).

## 8. Context management

- The system prompt is fixed for a session (N2). It holds the rules, the sandbox note, the MCP, web, web
  search, hooks, skills and agents notes when those features are on, the instruction files (`AGENTS.md`, `CLAUDE.md`, `GARUDA.md`) and
  `.garuda/memory.md`.
- At 80% of the context window, compaction runs: first it trims long tool outputs in older turns; if the
  context is still above 60%, the model summarises the older turns. The last 4 steps stay in full.
- `read_file` does not send the same lines of an unchanged file twice.

## 9. Extensions

| Extension | Configured in | Adds |
| --- | --- | --- |
| MCP servers (stdio) | `~/.garuda/mcp.json`, `.garuda/mcp.json` | Tools named `mcp__<server>__<tool>`. |
| Hooks | `~/.garuda/hooks.json`, `.garuda/hooks.json` | Checks before calls, feedback after calls. |
| Web fetch | `.garuda/settings.json` (`web`) | The `web_fetch` tool. |
| Web search (0.5) | `~/.garuda/search.json` or `BRAVE_API_KEY` / `TAVILY_API_KEY` (user only) | The `web_search` tool; with a `claude` section, Claude's search (0.6). |
| Skills (0.5) | `~/.garuda/skills`, `~/.claude/skills`, `.garuda/skills`, `.claude/skills` | The `skill` tool and `/name`. |
| Custom agents (0.5) | `~/.garuda/agents`, `~/.claude/agents`, `.garuda/agents`, `.claude/agents` | The `agent` tool and `/agents`. |
| Custom slash commands (0.4) | `~/.garuda/commands`, `.garuda/commands` | `/name` prompts. |
| Code index | `.garuda/settings.json` (`codeIndex`) | `find_symbol`, `find_references`, `repo_map`. |
| LSP diagnostics | `.garuda/settings.json` (`lsp`), `--lsp`, `~/.garuda/lsp.json` | Language server errors in edit results. |
| Language experts | `src/knowledge/` (`LanguageExpert`) | Code index support for a language. |
| Executors | `src/sandbox/` (`Executor`) | Another isolation technology. |
| Session stores | `src/session/` (`SessionStore`) | Another place for sessions. |

## 10. Chat interface

The Ink chat keeps all state in `ChatStore`. The store is also the renderer, the approver and the
Ctrl-C target of a turn, so the logic is testable without a terminal. Finished lines print once into
the terminal scrollback; the live area holds only the open text block, running tools, the approval
choice, the queue, the input line and a footer. See [cli.md](lld/cli.md).

Input (0.6): Esc stops a task; `\` + Enter or Alt+Enter make a new line; Ctrl-G or `/editor` opens
`$EDITOR`; `@path` attaches a file; `!command` runs a command as the bash tool would; Tab completes commands
and paths. A `Notifier` sends a desktop notification (OSC 9) or the bell when an approval waits or a long
task ends, and stays quiet while the window has focus (terminal focus reporting).

Custom slash commands (0.4) are Markdown prompts in `~/.garuda/commands` and `.garuda/commands`. A project
command shows its text and asks the first time, like project hooks. See [commands.md](lld/commands.md).

## 11. Quality

- About 540 unit and acceptance tests, all with the fake model.
- Contract tests run every executor (host, Seatbelt, bubblewrap) through the same suite.
- Architecture tests enforce the dependency rules.
- Evals: a basic suite (10 tasks), a hard suite (6 tasks on a generated repo of about 107 files), and
  Java and Python suites (5 tasks each, Maven with JUnit 5 and pytest).
  0.1 baseline on claude-sonnet-5: basic 10/10; hard 6/6 at about 50 steps and $0.19 in total.
