# Garuda

Garuda is a terminal coding agent. This is version 0.14.0-dev: the 0.14–0.17 branches after the merge gate
(see the note under the status table).
Design documents: [docs/](docs/README.md) (architecture, high-level design, low-level design per component).
The requirements doc defines the scope. Code, tests and commits refer to its IDs (F1–F26, N1–N8).

## Status

| Milestone | State |
| --- | --- |
| M1 Skeleton and fake model | Done |
| M2 Read-only tools | Done |
| M3 Write tools and permissions | Done |
| M4 Limits, context, sessions | Done |
| M5 CLI polish and evals | Done |
| 0.2: OS sandbox, Ink chat, MCP client (stdio), web_fetch, hooks | Done |
| 0.3: open models (OpenAI-compatible), Java and Python profiles and evals, explore subagent (opt-in), stream retries | Done |
| 0.4: AGENTS.md/CLAUDE.md, custom slash commands, plan mode, todo tool (opt-in), LSP diagnostics (opt-in), undo, remote MCP with OAuth | Done |
| 0.5: `garuda init` (AGENTS.md, migrate from other agents), JSON output (Claude Code format), skills, custom agents, web search | Done |
| 0.6: chat UX (Esc, multi-line, $EDITOR; @file, !cmd, completion; sessions and models in the chat; focus-aware notifications, /diff), Claude's web search | Done |
| 0.7: scheduled jobs (plan now, build later with an approval list, own branch), launchd, Batch API (step limit, finish-by time) | Done |
| 0.8: chat UX from the second OpenCode comparison (`/compact`, argument completion, fuzzy @, session rename and delete, `/plan <task>`) | Done |
| 0.9: `/details`, `/thinking` (effort, show), Claude's thinking blocks kept, command palette (Ctrl-P) | Done |
| 0.10: formatters after edits (opt-in; measured: +14% cost, no gain) | Done |
| 0.11: night shift (a queue of overnight jobs, one digest, a launchd agent) and proof of work (tests before and after, risk flags, a principal-engineer review) | Done |
| 0.12: benchmark your repo (eval tasks from the repo's own git history), output-limit recovery | Done |
| 0.13: network allowlist for commands (W6): presets or hosts, through Garuda's proxy, off by default | Done |
| 0.14: sandbox launch probe, core modularization, background daemons (opt-in), interactive patch staging (W4) | In 0.14.0-dev |
| 0.15: multi-language AST code intelligence (Python, Java, TS/JS, call graph, blast radius, /callers, /defs, /impact, ast_query) | In 0.14.0-dev |
| 0.16: language plugins (Go and Rust built in, user plugins in ~/.garuda/languages, /languages; project plugins not loaded) | In 0.14.0-dev |
| 0.17: Mixture-of-Experts subagents (opt-in), team policy and audit log (W5) | In 0.14.0-dev |

The 0.14–0.17 rows were built on stacked branches that were never released. They ship together as
0.14.0 after the merge gate: the high findings of the branch review are fixed (policy source, audit
log, hunk approval U0, daemons, MoE, project plugins), and features with no measured gain are off by
default (MoE, daemons). G02, G04 and G06 are fixed too. The open gaps G07 (child outcome), G08 and G09 are listed in
[docs/quality-baseline/issue-register.md](docs/quality-baseline/issue-register.md). The section
headings below keep the branch labels (0.14–0.17).

## Use

You need Node 22 or later and pnpm 10. Node 25 and later do not include corepack, so install pnpm with npm:

```sh
npm install -g pnpm@10
pnpm install
pnpm check          # typecheck + lint + tests
pnpm build
export ANTHROPIC_API_KEY=...
export GARUDA_MODEL=<model-id>
node dist/cli/index.js                                  # chat in the current folder
node dist/cli/index.js -p "Explain what this repo does" # run one task and exit
echo "Explain this repo" | node dist/cli/index.js       # the same, from stdin
```

Tools: read_file, glob and grep run with no question.
write_file, edit_file and bash show a diff or the command first. You pick: allow once, allow for this session, or deny.
Commands run in an OS sandbox when your machine has one (see Sandbox below). Without a sandbox,
each command asks first, so read each one before you allow it.
Garuda removes a leading `cd <working root> &&` from a command, because each command already starts there.
When the model reads files with bash, or pipes into head or tail, the result adds a short `[Garuda: …]` note that tells it to use the file tools.

For scripts and CI, `--output-format json` prints one JSON result, and `--output-format stream-json`
prints one JSON object per line as the task runs. The fields are those of Claude Code's headless mode
(`claude -p --output-format …`), so the same scripts work:

```sh
g -p "Run the tests" --output-format json | jq -r '.subtype, .total_cost_usd, .result'
g -p "Fix the lint errors" --output-format stream-json --verbose > run.jsonl
```

stdout holds only JSON; warnings and errors go to stderr (`--verbose` adds the tool activity). The exit
code does not change. Details: [docs/lld/cli.md](docs/lld/cli.md#json-output-jsonoutputts-05).

Try it on this repo:

```sh
node dist/cli/index.js -p "Where is runAgent defined, and what does it do?"
node dist/cli/index.js -p "Run the tests and tell me the result"
```

## Models

`-m` (or `GARUDA_MODEL`) takes a Claude model id, or `<provider>/<model>` for other providers:

```sh
g -m claude-sonnet-5                 # Anthropic (ANTHROPIC_API_KEY)
g -m ollama/qwen3-coder:30b          # Ollama on this machine
g -m lmstudio/<model>                # LM Studio (also: llamacpp/…, vllm/…)
g -m openrouter/qwen/qwen3-coder     # OpenRouter (OPENROUTER_API_KEY)
g eval -m ollama/qwen3-coder:30b -s hard   # measure an open model on the eval tasks
```

Set the context window, price and output limit per model, and add providers, in `~/.garuda/models.json`:

```json
{
  "providers": { "lab": { "type": "openai-compatible", "baseUrl": "https://llm.example.com/v1", "apiKeyEnv": "LAB_KEY" } },
  "models": { "ollama/qwen3-coder:30b": { "contextWindow": 65536, "maxTokens": 8192 } }
}
```

- Only this file in your home folder can define providers; a project cannot send your code elsewhere.
  Keys come from environment variables. Plain http works only to this machine (or with
  `"allowInsecureHttp": true`).
- Some small models write a tool call as JSON text. When the whole reply is such a call to a known
  tool, Garuda runs it as a real call, with the usual approvals. For a model that also writes
  sentences around the call (for example `qwen2.5-coder:7b`), set `"textToolCalls": "lines"` for that
  model: then a call on its own line runs too. A call in the middle of a sentence never runs.
- Without a `contextWindow`, Garuda assumes 32 768 tokens for open models and says so. The server must
  allow the window too: for Ollama, start it with `OLLAMA_CONTEXT_LENGTH=65536 ollama serve`.
- Local models cost $0. Tool calling quality varies by model: measure a model with `g eval` first.

## Chat mode

`garuda` with no task starts a chat. Each line is one task; the conversation carries over.

- `/help`, `/usage` (tokens and cost), `/session` (id and file), `/new` (new session), `/commands`
  (your custom commands), `/plan` and `/build` (plan mode), `/undo` and `/redo`, `/lsp` (language servers),
  `/init` (set up this folder, see below), `/editor`, `/compact`, `/details`, `/thinking`, `/diff` (see Undo), `/schedule` and `/jobs` (see
  Scheduled jobs), `/exit`. Your custom commands and
  skills run with `/name`.
- `/sessions` lists this project's sessions (newest first: time, first prompt, turns, cost, model).
  `/sessions <number or id>` continues one in the chat, as `--resume` does. Read tracking starts again.
  `/sessions rename <number or id> <title>` gives a session a title for the list. `/sessions delete <number
  or id>` asks, then deletes the session file and its subagent logs for good; the open session cannot go.
- `/models` lists the known Claude models and the models in `~/.garuda/models.json`, with context window and
  price. `/models <number, id or opus|sonnet|haiku|fable>` switches the main model for the next turns of this
  chat. The session records the change; a new chat starts with `-m` or `GARUDA_MODEL` again. The prompt cache
  starts again; a smaller window makes Garuda compact the conversation first. Explore keeps the start model.
- `/export [file]` writes the conversation as Markdown in the working folder (default
  `garuda-<session id>.md`): prompts and answers in full, one line per tool call. It comes from the session
  file, so secrets are redacted. It never overwrites a file and never writes outside the folder.
- `/compact [what to keep]` summarises the older turns now, to free context before a new part of the
  work. The last 4 steps stay in full. The optional text tells the summary what to keep, for example
  `/compact keep the API decisions`. Esc stops it; the conversation then stays as it was. Garuda still
  compacts on its own when the context gets full.
- `/details` hides the result line under each tool call (`⎿ 12 line(s)`), so a turn shows one line per
  call. A failed call still shows its result, and Ctrl-O still shows the last output in full. `/details`
  again, or `/details on`, shows them. It applies to new lines only.
- `/thinking` controls Claude's thinking for this chat. Claude Opus 5.5, Opus 5 and Sonnet 5 always think;
  Opus 4.6 to 4.8 and Sonnet 4.6 think only after `/thinking on`. `/thinking low|medium|high|xhigh|max`
  sets the effort (less or more thinking; `default` goes back). `/thinking show` asks for readable
  thinking: the chat shows its first lines dimmed, and Ctrl-O shows all of it until the next tool output
  replaces it; `hide` goes back. The session
  records the choice; `"thinking": { "effort": "low", "show": true }` in settings sets the start value. A
  change starts the prompt cache again. Other providers do not offer it.
- Esc or Ctrl-C during a task stops the task and kills its commands (Esc also drops queued lines). The
  chat goes on, and the model learns with your next message that you stopped the task, so it does not
  go on with it unless you ask. A second Ctrl-C during the task exits Garuda at once; Esc never exits.
- New lines: end the line with `\` and press Enter, or press Alt+Enter (Option+Enter on a Mac with
  "Use Option as Meta"). Pasted text keeps its new lines and is never sent by itself.
- `@path` attaches a file or folder: `fix the bug in @src/cart.ts`. The file's text goes with your
  message (numbered, up to 2,000 lines) and counts as read, so the model can edit it at once; a folder gives
  its list of entries. The same rules as `read_file`: only files in the folder, no secrets (`.env`, keys).
  Garuda shows what it attached. A word after `@` that is not a path stays text.
- `!command` runs a command yourself, like the bash tool: in the sandbox with no question, deny rules and
  hooks apply. You see the output, and it goes to the model with your next message. Esc stops it.
- Tab completes `/commands` (built-in, your own, skills) and `@paths`; with several matches it lists them.
  It also completes arguments: `/models <model>`, `/sessions <id|rename|delete>` (with each session's
  title), `/jobs <id|cancel>`, `/diff last`, `/mcp logout <server>` and `/lsp install <language>`.
- When no path starts with what you typed after `@`, Tab searches all files by their letters in order:
  `@rntm` finds `src/app/runtime.ts`. One match completes; otherwise the best 10 are listed. The search
  skips hidden files, `node_modules`, `dist`, `build`, `target` and virtual environments.
- Ctrl-P opens the command palette (full chat only): every command with its one-line help, then your
  own commands and skills. Type to filter: `thk` finds `/thinking`; when no name matches, words of the
  help do (`markdown` finds `/export`). ↑/↓ choose. Enter runs a command that needs no arguments (`/usage`, `/undo`, `/details` …) or puts
  `/name ` in the input line for one that takes them (`/models`, `/sessions`, `/thinking` …), so Tab can
  complete the rest. Esc or Ctrl-P closes it.
- Ctrl-G (or `/editor`) opens the prompt in `$VISUAL` or `$EDITOR` (default `vi`). The saved text comes
  back into the input line; press Enter to send it. The plain chat also joins lines that end with `\`.
- At the prompt, Ctrl-C clears the line; Ctrl-C twice (within 2 s) or Ctrl-D exits.
- On a terminal, the chat uses Ink (0.2): model text streams, and each finished paragraph gets
  basic markdown styles. A spinner shows running tools. The footer shows the model, the sandbox,
  the context use and the cost.
- Type-ahead: type during a task and press Enter to queue the next task.
  Keys typed before the chat is ready are kept too.
- Ctrl-O prints the full output of the last tool call. ↑ and ↓ browse earlier inputs.
- Approvals show the full diff or command in the scrollback. Answer with ↑↓ and Enter, or
  y (once), a (session), n or Esc (deny). For `edit_file`, press `h` (or `p`) to review hunks one by one (0.14): only the hunks you stage
  are written, and the model is told which ones you rejected. A diff too long to show in full has no `h`.
- `GARUDA_PLAIN=1` turns Ink off. Pipes, `-p`, the evals and the standalone binary always use plain output.
- Notifications: when an approval waits during a task, and when a task that ran 10 s or longer ends, Garuda
  tells you. In iTerm2, Ghostty and WezTerm it sends a desktop notification (the OSC 9 escape code); in other
  terminals and in tmux it rings the bell. `GARUDA_NOTIFY=off|bell|osc9|auto`, or
  `"notifications": { "channel": "off", "afterSeconds": 30 }` in `.garuda/settings.json`, changes it.
  In iTerm2 the notification needs "Send escape sequence-generated alerts" (Settings › Profiles › Terminal),
  which is on by default.
  In iTerm2, Ghostty, WezTerm and the VS Code terminal, the full chat turns on focus reporting: while
  Garuda's window has focus, no notification goes out. In other terminals, in tmux and in the plain chat,
  every notification goes.
- Files are written atomically (a temporary file, then a rename), so an exit never leaves half a file.
- `garuda --resume` continues the latest session in chat mode.

Model text goes to stdout; tool activity and notes go to stderr. So `garuda -p "…" > answer.md` keeps only the answer.

## Init: set up a folder

`garuda init` (or `/init` in the chat) sets up the current folder:

1. It reads the files of other coding agents: Claude Code, OpenCode, Codex, Gemini CLI, Tabnine, Cursor
   and Copilot. It shows what goes where (MCP servers, slash commands, permission rules), then asks once.
   It writes **new files only**: an existing `mcp.json`, `settings.json` or command file is never changed.
   It adds Garuda's local folders to `.gitignore`. Secret values (tokens, keys) are never copied; they
   become `${NAME}`, so set them in your environment.
2. If the folder is not a git repository, it offers `git init`.
3. In a code project, the model reads the code and writes or improves `AGENTS.md` (build and test
   commands, structure, conventions). It also reads other agents' instruction files (`GEMINI.md`,
   `.cursorrules`, `.github/copilot-instructions.md` …) and carries over what applies. In an empty folder,
   it asks what you want to build first.

When a folder has no `AGENTS.md`, or has another agent's files, the chat start shows a hint to type `/init`.
Imported project servers and commands still ask for consent the first time. Details: [docs/lld/init.md](docs/lld/init.md).

## Custom slash commands

Save a prompt as a Markdown file and run it with `/name`:

```markdown
<!-- ~/.garuda/commands/review.md (yours) or .garuda/commands/review.md (the project's) -->
---
description: Review a file for bugs
argument-hint: <path>
---
Review $1 for bugs and missing tests. List the problems by severity.
```

- `/review src/cart.ts` in the chat, or `garuda -p "/review src/cart.ts"`. `$ARGUMENTS` takes all
  arguments, `$1` … `$9` one each. `/commands` lists them; `/help` shows them too.
- A subfolder gives a name with a colon: `frontend/test.md` → `/frontend:test`.
- A command is only a prompt. Its tool calls ask or run in the sandbox as usual.
- A project command shows its full text and asks the first time. "Remember" pins the answer to the
  file; a changed file asks again. Built-in commands, and your own commands, win over project commands
  with the same name.

## Skills

A skill is a folder with a `SKILL.md`: instructions for one kind of task, in the
[Agent Skills](https://agentskills.io/specification) format that Claude Code uses. Garuda reads your
Claude Code skills where they are.

```markdown
<!-- ~/.garuda/skills/release-notes/SKILL.md (or ~/.claude/skills, .garuda/skills, .claude/skills) -->
---
name: release-notes
description: Write release notes from the git log. Use when the user asks for release notes or a changelog.
---
Read `git log --oneline $0..HEAD`. Group the changes into Added, Changed and Fixed. Follow
references/style.md in this folder.
```

- The model sees each skill's name and description. When a task matches, it loads the skill with the
  `skill` tool, and reads the skill's other files (`references/`, `scripts/`) only when it needs them.
- Run one yourself: `/release-notes v0.4.0`. `$ARGUMENTS`, `$0`, `$1` … and `${CLAUDE_SKILL_DIR}` work as in
  Claude Code. A skill wins over a custom command with the same name. `/commands` lists them.
- A project skill shows its full text and asks the first time it loads. "Remember" pins the answer to
  SKILL.md; a changed file asks again. Your own skills win over project skills with the same name.
- `disable-model-invocation: true`: only you can run it. `user-invocable: false`: only the model can.
  `allowed-tools` is ignored: every call still asks or runs in the sandbox.
- Nothing changes when you have no skills. `"skills": { "enabled": false }` in `.garuda/settings.json`
  turns them off. Details: [docs/lld/skills.md](docs/lld/skills.md).

## Plan mode

In plan mode the agent reads the code and writes a plan; it cannot change anything.

- `/plan` and `/build` switch the mode; in the chat, Shift+Tab toggles it. `garuda --plan` starts in plan
  mode. The footer shows `PLAN`. `/plan <task>` switches and plans the task at once (`/build <task>` too).
- Allowed: reading tools, and bash in the sandbox, which then cannot write the project (temp folders and
  package caches only), so read-only commands and many tests still work. Denied, with no question: file
  edits and writes, `remember`, commands outside the sandbox, and web_fetch or MCP tools without an allow
  rule. With no OS sandbox, bash is off in plan mode.
- When the plan is ready, Garuda asks "Build this plan?": build it now, switch to build mode and type the
  task yourself, or keep planning.

## Undo

Before each turn, Garuda takes a snapshot of the project. `/undo` takes back the last turn: its file
changes (edits, new and deleted files, and files that commands changed) and its messages, so the model
forgets it. `/redo` brings it back.

- It asks first, with the list of files. Changes that you made after the turn go back too.
- Snapshots are in `~/.garuda/snapshots`, in a git store of Garuda's own. Your repository, index and
  branches do not change, and the project does not need git. `.gitignore` rules apply.
- It works after `garuda --resume`. After the conversation was compacted, undo restores only the files.
- Cost: about 15–90 ms per turn. `"undo": { "enabled": false }` in `.garuda/settings.json` turns it off.
- `/diff` shows what changed since the first turn of this session: the files with `+`/`−` line counts, then
  the diff (300 lines; Ctrl-O shows all). `/diff last` shows only the last turn; `/diff <path>` or
  `/diff last <path>` limits it to one file or folder. It compares with the files now, so your own changes
  count too. It uses the undo snapshots, so it is off when undo is off.

## Formatters (opt-in)

With `"formatters": { "enabled": true }` in `.garuda/settings.json`, Garuda runs the project's own
formatter on each file that `edit_file` or `write_file` changes, and the result shows what it changed:

```
Edited src/cart.ts.
Formatted with prettier:
-  const total=items.reduce((s,i)=>s+i.price,0)
+  const total = items.reduce((s, i) => s + i.price, 0);
```

- It finds Biome or Prettier (their config and `node_modules/.bin`), ruff or black (`pyproject.toml`,
  a venv or PATH), gofmt (`go.mod`) and rustfmt (`Cargo.toml`). It never installs a formatter.
- `"commands"` changes the list: `{ "prettier": false }` turns one off; `{ "mine": { "extensions":
  ["txt"], "command": ["fmt", "$FILE"] } }` adds one or replaces a detected one.
- Formatters run only in the OS sandbox, like the model's commands. A failed formatter adds a note; it
  never undoes the edit.
- Off by default until measured: `garuda eval -s hard --repeat 3 --format on` (and `--format off`).

## LSP diagnostics (opt-in)

With `garuda --lsp`, or `"lsp": { "enabled": true }` in `.garuda/settings.json`, a language server checks
each file that `edit_file` or `write_file` changes, and the result lists its errors:

```
Edited src/cart.ts.

1 error in src/cart.ts after this change (tsc):
  14:7 Type 'string' is not assignable to type 'number'. [2322]
```

- TS/JS: TypeScript 7 (`tsc --lsp`), `tsgo` or `typescript-language-server`. Python: basedpyright or
  pyright. Java: jdtls (it needs Java 21 or later; `JAVA_HOME` or a usual JDK folder). For a Maven or
  Gradle project, jdtls starts with the first task, because its project import takes a while.
- Garuda uses a server on your PATH (for Java also `brew install jdtls`), or its own copy:
  `garuda lsp install typescript` (or `python`, `java`) installs a pinned version into `~/.garuda/lsp/`. With `{ "autoInstall": true }` in
  `~/.garuda/lsp.json`, Garuda asks to install a missing server at the first edit.
- `garuda lsp` (or `/lsp` in the chat) shows the servers and their state.
- Servers run only in the OS sandbox: the project is read-only for them, and they have no network. A
  missing, slow or broken server never blocks an edit.
- Off by default: in the A/B eval on the hard suite the model made no type errors, so LSP had nothing to
  catch. Measure it again with `garuda eval -s hard --repeat 3 --lsp on`.

## Todo list (opt-in)

`"todo": { "enabled": true }` in `.garuda/settings.json` gives the model a `todo_write` tool: for a task
with 3 or more steps it keeps a plan, and the chat shows it as a checklist (`✔`, `▶`, `○`). It is off by
default: in the A/B eval on the hard suite the model never called it. Measure it again with
`garuda eval -s hard --repeat 3 --todo on`.

## Evals

`garuda eval` runs eval tasks in scratch folders and reports pass or fail, steps, tokens and cost per task (N5).
A task passes when its check command exits with 0 and the agent did not change the task's tests.
The 0.1 target is 7 of 10.

```sh
garuda eval --list                         # the tasks of each suite
garuda eval -m claude-sonnet-5             # the basic suite (10 small repos)
garuda eval -s hard                        # the hard suite (6 tasks on a 110-file repo)
garuda eval -t fix-add hard-rename --keep  # some tasks, keep the scratch folders
garuda eval -s hard --repeat 3             # each task 3 times, with a mean row per task
garuda eval -s hard --repeat 3 --index lookup  # the same, with find_symbol and find_references (A/B)
garuda eval -s java                        # 5 Maven projects with JUnit 5
garuda eval -s python                      # 5 pytest projects
garuda eval -s hard --repeat 3 --subagents on   # A/B: the same, with the explore subagent
garuda eval --parallel 4                   # 4 tasks at the same time
garuda eval --batch on                     # A/B: model calls through the Batch API (half price, slow)
garuda eval -s hard --keep-thinking off    # A/B: drop Claude's thinking blocks, as before 0.9
garuda eval -s hard --format on            # A/B: Biome formats after each edit (and --format off)
```

`--batch on` (0.7, Anthropic models) sends every model call as a batch of one: half the token price,
but each step waits until its batch ends (usually minutes). It runs all tasks at the same time (up to 20;
`--parallel` changes it) and gives each task 12 hours. The report shows the share of tokens from the
prompt cache and the wall time, to compare with `--batch off`.

The Java and Python suites need a toolchain. `garuda eval` checks it before the first model call and
says what is missing:

- Java: a JDK (17 or later), Maven, and JUnit 5 in `~/.m2`. Run `garuda eval --prepare java` once: it
  runs Maven on a small project with network, to download the plugins and JUnit. The evals then run
  offline.
- Python: `python3` with pytest 7 or later (`python3 -m pip install --user pytest`).
  `garuda eval --prepare python` checks it.

The checks guard against shortcuts: the tests and build files (`pom.xml`, `pyproject.toml`) are
protected, the Java check refuses a `.mvn` folder, and pytest reads only `pyproject.toml` and no
`conftest.py`.

### Benchmark your repo (0.12)

Measure Garuda on your own code. `--from-git` turns recent commits that changed code and tests into
tasks: the agent starts at the commit's parent, gets the commit message and the commit's tests, and
passes when the tests pass and it did not change them.

```sh
garuda eval --from-git                     # build .garuda/evals/repo-suite.json from the last 200 commits
garuda eval --from-git --since 2026-01-01 --max-tasks 10 --test-command "pnpm test"
garuda eval -s repo --list                 # the tasks
garuda eval -s repo -m claude-sonnet-5     # run them (the A/B flags work too)
```

A commit is kept only when its tests fail at the parent and pass at the commit. Garuda runs only the
commit's test files when it knows the runner; `--test-command "make test T={files}"` works for others.
Commits that change dependencies, binary files or more than 10 code files are skipped. Building runs your test command twice per
candidate on this machine, with no sandbox, in git worktrees: your checkout does not change.

The runner approves every call except its deny rules (`rm -rf`, `sudo`, `git push`, `curl`, `wget`).
Commands run in the scratch folders, in the OS sandbox when there is one (`--executor auto|os|host`). Results and session files go to
`.garuda/evals/<run-id>/`.

`pnpm startup` checks that startup takes less than 1 s (N3). The Anthropic SDK and the prompt library
load on first use, not at startup.

## Code index and dynamic language plugins (local knowledge)

Garuda keeps a local code index with a dynamic language plugin architecture (0.16).
It answers code questions on this machine, with zero native C++ compilation dependencies and no model call:

- Built-in language plugins: TypeScript/JavaScript, Python, Java, Go, and Rust.
- Dynamic plugin system:
  - User plugins: Drop custom language experts in `~/.garuda/languages/<lang>.js`.
  - Project plugins (`<root>/.garuda/languages/`) are not loaded (merge gate). A plugin runs inside
    Garuda's own process with no sandbox, there is no consent flow yet, and a hash pin of the entry file
    does not cover the files it imports (G09). `/languages` names the plugins that were skipped.
  - Tests and evals load the built-in experts only.
- Tools for the agent (read-only, no approval), chosen with `"codeIndex"` in `.garuda/settings.json`:
  `"off"` (default), `"lookup"` (`find_symbol`, `find_references`, `find_callers`, `impact_analysis`, `ast_query`) or `"all"` (also `repo_map`).
  `find_callers` traces structural invocation hierarchies across languages; `impact_analysis` computes blast radius, dependents, and discovers affected test suites (including Go `*_test.go` and Rust `*_test.rs`); `ast_query` filters symbols by kind, container, and wildcards.
- Chat commands for you: `/where X` (or `/defs X`), `/refs X`, `/callers X`, `/impact X`, `/map [folder]`, and `/languages` (lists active language plugins, indexed file counts, and standby status).
- The code graph (files, exports, imports) is cached in `.garuda/index/code-graph.json` by file hash.
  Pure AST parsers run in-process and preserve single-binary distribution.
- Files follow `.gitignore`. Sensitive files are never indexed.

## Mixture-of-Experts (MoE) subagent dispatch and /experts (0.17)

Garuda features an autonomous Mixture-of-Experts (MoE) dispatch architecture for polyglot codebases:

- **Specialist profiles**: Dedicated subagents for Go, Rust, Python, Java, and TypeScript equipped with language-idiomatic prompts, toolchain testing commands (`cargo test`, `go test ./...`, `pytest`, `mvn test`, `pnpm test`), and scoped AST tools.
- **Dynamic delegation**: The primary orchestrator agent can invoke `delegate_expert({ language, task, files })` to dispatch complex language-specific tasks to child subagents. The child subagent runs with full AST code tools, executes language tests, and returns a synthesized report without cluttering the primary context window.
- **Chat command**: `/experts` lists all available language specialists, their active test commands, and their active status / indexed file counts.
- **Banner & Observability**: The startup banner features a dedicated `subagents` row (`subagents: explore · 5 MoE experts (Go, Rust, Python, Java, TS)`). In session, `/session` provides a full breakdown of active subagents, agents, skills, and tools.
- **Configuration**: off by default (no measured gain yet). Turn it on with `"moe": { "enabled": true }` in
  `.garuda/settings.json`; `subagents` alone does not turn it on. One `delegate_expert` call runs at a
  time, because a specialist can write files (merge gate, G05).

## Team policy and structured audit log (0.17, W5)

A team policy sets limits that a project cannot loosen, and an audit log records the permission decisions:

- **Team policy**: guardrails that a project's settings cannot loosen. Garuda reads the managed file
  (`/Library/Application Support/Garuda/policy.json` on macOS, `/etc/garuda/policy.json` on Linux;
  an admin writes it) and `~/.garuda/policy.json`. Where both exist, the stricter value wins: lists of
  denials add up, `requireSandbox` and `strictAllowlist` are on when either sets them, limits take the
  lower value, and `allowedModels` and `audit` come from the managed file when it sets them. A broken
  file stops Garuda. A project's own `.garuda/policy.json` is ignored with a notice: a cloned repo
  could otherwise remove its own limits. The chat, `-p`, jobs, the night shift and `garuda eval` all
  use the policy. `/audit` names the files. The keys:
  - `disallowedCommands`: command patterns that are denied in every run (for example
    `["rm -rf *", "git push *--force*"]`). A compound command is denied when one of its parts matches.
  - `requireSandbox`: When `true`, no command runs outside the OS sandbox: `outside_sandbox` is
    denied, and on a machine with no OS sandbox every command is denied.
  - `denyPaths`: root-relative path patterns that the agent may not read or write (for example
    `["**/.env*", "secret/**"]`). File tools refuse them; `grep`, `glob` and the code index skip them
    (no content, no name). Commands in the OS sandbox cannot read or write them either: the matching
    files and folders are added to the sandbox profile when each command starts (not searched:
    `node_modules`, `.git`; at most 1,000 paths). A symbolic link to a denied file is denied too.
  - `allowedModels`: Allowlist of LLM models permitted for use in the organization.
  - `network`: `blockedHosts` (`*.example.com` for subdomains) and `strictAllowlist`. A blocked host
    stays blocked for `web_fetch` and for sandboxed commands, also when the project's
    `network.allow` lists it.
  - `limits`: Global caps on `maxSteps` and `tokenBudget`.
- **Structured audit log** (`~/.garuda/audit/<project>-<hash>/`, one file per Garuda process): on in
  the chat, `-p` and jobs (a job writes under its main checkout's folder, so the log outlives the
  worktree); off in evals and tests; the team policy can turn it off (`audit.enabled: false`) or make it
  mandatory (`audit.enabled: true`: a failed write then fails the call). Without a policy a failed write
  gives one notice. It is not in the project, so the agent's own tools cannot edit it. Targets and
  reasons pass the session redactor, so known secret formats (keys, tokens, `password=…`) are removed. Each line has `seq`,
  `prev` and `hash` (sha256): `/audit verify` shows a changed, removed or inserted line. This makes the
  log tamper-evident, not tamper-proof: a user who can write the file can rewrite the whole chain.
  Each line records:
  - Every authorization decision (`allow_readonly`, `allow_sandbox`, `deny_policy`, `deny_user`, etc.).
  - Security risk classification (`low`, `medium`, `high`, `critical`).
  - Tool execution duration in milliseconds and error status.
- **Chat command**: `/audit` displays active policy rules and recent audit events. Use `/audit stats` for totals, `/audit denials` for security blocks, `/audit verify` to check the hash chains, or `/audit <n>` for recent events. Not recorded yet: the tool outcomes inside a subagent run (only their permission decisions, G07).

## Sessions, limits and context

Every run writes a session file: `.garuda/sessions/<id>.jsonl` (one JSON record per line, mode 0600).
It holds every message, tool call, result, token count and cost. Garuda redacts known secret
formats (API keys, tokens, private keys, `password=…`) and the values of secret-looking environment
variables before it writes a line. The model can still see a secret; the file never holds it.

```sh
garuda -p "Find the flaky test"                 # new session
garuda --resume -p "Now fix it"                 # continue the latest session
garuda --resume 20260923-201500-a1b2 -p "…"     # continue a given session
garuda --replay 20260923-201500-a1b2            # replay it: no API calls, no tools run
```

- After each turn Garuda prints steps, tokens (with cache reads), cost, context use and the session total.
- A run stops at 50 steps, at the session token budget (20M tokens), or after the same tool call
  3 times in a row. Garuda says why.
- When the connection to the model breaks while a response streams, Garuda sends the request again (up
  to 2 times) and says so. The session keeps only the complete response.
- At 80% of the context window, Garuda first cuts long tool outputs in older turns. If that is not enough,
  the model summarises the older turns. The last 4 turns always stay in full.
- `AGENTS.md`, `CLAUDE.md` and `GARUDA.md` in the project root go into the system prompt, in that order;
  `GARUDA.md` wins on a conflict. A file with the same text as an earlier one goes in once.
- Project memory: the `remember` tool saves lasting facts (build and test commands, layout, conventions)
  to `.garuda/memory.md`, with your approval. The next session loads them after `GARUDA.md`.
  Edit or delete lines freely. Add `remember` to `permissions.allow` to skip the question.
- `read_file` does not send the same lines of an unchanged file twice. After compaction it sends them again.
- Garuda knows the price and context window of current Claude models. For other models, set them in settings.

## Sandbox

Garuda runs commands in an OS sandbox: Seatbelt (`sandbox-exec`) on macOS, bubblewrap (`bwrap`) on Linux.
In the sandbox, a command:

- can read every file, except secrets in your home folder (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`,
  `~/.docker`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials`, keychains, Garuda's and Claude Code's tokens and more);
- can write only in the working root, the temp folders and package caches (`~/.cache`, `~/.npm`, pnpm,
  and for a Java or Python project `~/.m2/repository`, `~/.gradle/caches` and similar);
- cannot write `.git/hooks`, `.git/config` or `.garuda/` in the root, because those run or apply later
  outside the sandbox;
- has no network (localhost works on macOS), unless you open a network allowlist (0.13, below).

Commands in the sandbox run with no approval. Deny rules still apply. When the sandbox blocks a command
(for example `pnpm install` needs the network), the model can ask to run it outside the sandbox.
That always asks you first, and the prompt says "OUTSIDE the sandbox".

Settings:

```json
{
  "executor": "auto",
  "sandbox": { "writePaths": ["~/tools/cache"], "denyRead": ["~/work-secrets"] }
}
```

- `executor`: `auto` (default) uses the sandbox when it works on this machine, else runs on the host
  with a notice. `os` requires the sandbox. `host` turns it off, and every command asks again.
- `sandbox.writePaths` and `sandbox.denyRead` add paths. `~/` is the home folder; other relative paths
  start at the root.
- macOS sandbox probe (0.14): at startup Garuda runs `true` through `/usr/bin/sandbox-exec` once. When
  that fails (for example in a nested sandbox), `auto` falls back to the host with a notice that gives
  the first line of the error.
- On Linux, install bubblewrap (`sudo apt install bubblewrap`). Some systems block the user namespaces
  that it needs; Garuda then falls back to the host and says why.

### Network allowlist (0.13)

Installs and builds need a package registry, but not the whole internet. The allowlist lets commands in
the sandbox reach named hosts through Garuda's own proxy, with no question:

```json
{ "network": { "allow": ["npm", "pypi", "api.example.com", "*.example.org"] } }
```

- Presets: `npm`, `pypi`, `maven`, `go`, `cargo`, `github` (each names its registry hosts). A host with
  `*.` matches its subdomains. Only ports 80 and 443.
- Off by default. The first turn shows the list and asks; "remember" pins it to the list in
  `~/.garuda/trust.json`, so a changed list asks again. The model then gets a note that names the hosts,
  so it runs those commands in the sandbox and does not ask to leave it.
- A host that is not on the list asks you (once, this session, or no); `network(host)` in
  `permissions.allow` or `permissions.deny` answers for good. Jobs and evals deny it and say which host.
- Commands get `HTTP_PROXY` and `HTTPS_PROXY`: npm, pnpm, yarn, pip, cargo, go, git and curl use them;
  Node's `fetch` too (`NODE_USE_ENV_PROXY`, Node 24 or later); Maven and Gradle through `MAVEN_OPTS` and
  `GRADLE_OPTS`. A tool that ignores the proxy variables still has no network.
- The proxy does not read the traffic: for https it sees only the host name. A host must resolve to
  public addresses; the proxy connects to the address it checked.
- On Linux the proxy reaches bubblewrap's network namespace through a small bridge that runs with
  `node`; with no `node` on the PATH the allowlist stays off and Garuda says so.
- A job keeps the list that was in effect when you scheduled it (the approval shows it).
  `garuda eval --network npm,pypi` measures a suite with the list.
- Limit on Linux: a protected path that does not exist yet (for example `.git/hooks` in a folder with no
  `.git`) is not protected.

### Background daemons (0.14, off by default)

Dev servers and watchers can run in the background. This is off by default (no measured gain yet).
Turn it on with `"daemons": { "enabled": true }` in `.garuda/settings.json`.

- With the setting on, `bash` takes `is_daemon: true`: the command starts through the same executor
  (the same sandbox and approval as any command) and the tool returns at once with a `daemonId`.
- The `process_manager` tool has `list`, `status`, `logs` (`lines`, `stream`) and `kill` for daemons
  that Garuda started in this session. It cannot touch other processes, so it runs without a question.
- Logs are kept in memory: the newest 2,000 lines per daemon, at most 4,000 characters per line, and
  `logs` returns at most 30,000 characters (the newest lines).
- When the session closes, Garuda stops every running daemon (SIGTERM to the process group, then
  SIGKILL).

## Custom agents

A custom agent is a Markdown file in Claude Code's subagent format. Garuda reads your Claude Code agents
where they are.

```markdown
<!-- ~/.garuda/agents/test-writer.md (or ~/.claude/agents, .garuda/agents, .claude/agents) -->
---
name: test-writer
description: Writes unit tests for a module. Use when the user asks for tests.
tools: Read, Grep, Glob, Write, Bash
model: haiku
---
You write focused unit tests with the project's test tool. Run them before you answer.
```

- The model hands a task to an agent with the `agent` tool. The agent works in its own context with its
  own instructions and tools, and returns a short report. Agents cannot start agents.
- Without `tools`, an agent can only read. Named write tools and bash still ask or run in the sandbox,
  and plan mode holds. An agent that may write never runs at the same time as another call.
- `model`: `haiku`, `sonnet`, `opus`, or a model id (your own agents only). Default: `--subagent-model`,
  else the main model. Its tokens and cost count in the session.
- A project agent shows its tools and instructions and asks the first time. Your own agents win over
  project agents with the same name (in Claude Code, the project wins).
- `/agents` lists them. Nothing changes without agent files; `"agents": { "enabled": false }` turns them
  off. Details: [docs/lld/agents.md](docs/lld/agents.md).

## Explore subagent

Off by default. Turn it on with `"subagents": { "enabled": true }` in `.garuda/settings.json`.
An A/B eval on the hard suite showed no gain in steps or cost (details in `docs/lld/agents.md`); it may
help in long chats on large repositories.

For an open question about the code ("where is the coupon applied, and who calls it?"), the model can
call `explore`. A subagent searches with `glob`, `grep` and `read_file` in its own context and returns a
short answer with `path:line` references. The main context stays small, and several explore calls can
run at once.

- The subagent can only read. It uses the same permissions and hooks, so secrets stay blocked.
- Limits per call: 20 steps and 150 000 tokens. When it hits a limit, it still answers with what it
  found, and says so.
- It uses the main model. `--subagent-model <spec>` (or `GARUDA_SUBAGENT_MODEL`) picks another one, for
  example `claude-haiku-4-5` under Sonnet. Its tokens and cost count in the session totals.
- The chat shows one live line per call (`explore … · step 3 · grep /coupon/`); Ctrl-O shows the answer
  and what it searched. Each run has its own file in `.garuda/sessions/<session id>/`.
- Settings: `"subagents": { "enabled": true, "maxSteps": 20, "tokenBudget": 150000 }`.

## Java and Python projects

Garuda finds the build tool from files in the working root and tells the model how to build and test.
The banner shows what it found, for example `Java (Maven)`.

| Found | Test command | The sandbox may also write |
| --- | --- | --- |
| `pom.xml` | `mvn -B -q -o test` (or `./mvnw`) | `~/.m2/repository`, `~/.m2/wrapper` |
| `build.gradle(.kts)`, `settings.gradle(.kts)` | `gradle test --offline -q` (or `./gradlew`) | `~/.gradle/caches`, `wrapper`, `daemon` and other cache folders |
| `pyproject.toml`, `setup.py`, `requirements.txt` … | `python3 -m pytest -q` (or the project's `.venv`, `uv run`, `poetry run`) | `~/.local/share/uv` |

- The commands run offline, because the sandbox has no network. When a dependency is missing, the model
  asks to run the download outside the sandbox, and you approve it.
- Settings files and init scripts (`~/.m2/settings.xml`, `~/.gradle/init.d`, `gradle.properties`) stay
  read-only: the build tool runs them later, outside the sandbox.
- `GARUDA.md` can override the detected commands. Gradle in the sandbox is not tested yet.

## MCP servers

Garuda connects to local MCP servers over stdio (0.2) and to remote servers over Streamable HTTP,
with OAuth sign-in (0.4).

```json
{
  "servers": {
    "github": {
      "command": "github-mcp-server",
      "args": ["stdio"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
      "network": true
    }
  }
}
```

- Your own servers go in `~/.garuda/mcp.json`. A project can add servers in `.garuda/mcp.json`.
- Keys per server: `command`, `args`, `env`, `network` (default false), `writePaths`,
  `timeoutMs` (default 60000), `enabled`. `${NAME}` in an env value comes from your environment,
  so secrets stay out of the file.
- Servers start with the first task. `/mcp` shows their state.
- A remote server needs only its URL: `"linear": { "url": "https://mcp.linear.app/mcp" }`. When it
  asks for a sign-in, Garuda asks you, opens your browser, and keeps the tokens in
  `~/.garuda/mcp-auth.json` (only you can read it). Tokens refresh by themselves;
  `/mcp logout <server>` removes them.

Security:

- A project server can come from a cloned repo, so Garuda asks before it starts one. The question
  shows the full command, the sandbox, the network setting, the env variables and warnings
  (npx, shell commands, secrets). "Remember" pins your answer to a hash of the definition in
  `~/.garuda/trust.json`; any change asks again. A project cannot replace one of your own servers.
- A remote server is not in the sandbox: it runs on another computer and gets the arguments of its
  tool calls. A project's remote server needs your consent (pinned to its URL), must use https and a
  public address, and Garuda checks the address at each connection.
- Each local server runs in the OS sandbox, like bash: it can write only in the project and temp folders,
  cannot read `~/.ssh` and other secrets, and has no network unless `"network": true`.
  It gets only the normal environment variables and the ones in its `env`.
- Garuda remembers each server's tools (a hash per tool). When they change later (a "rug pull"),
  Garuda warns you and says which tools were added, removed or changed, with the new descriptions.
  A project server needs your consent again.
- When a configured server is not available (you said no, it failed or it stopped), Garuda tells
  the model once in a `<garuda_note>`, so the model says so instead of guessing. Server text cannot
  pose as such a note or close its `<mcp_result>` wrapper.
- Every MCP tool call asks for approval and shows its arguments. Server hints such as
  `readOnlyHint` are shown, never trusted. Allow rules skip the question:
  `mcp__github__get_issue` or `mcp__github__*`.
- Tool names get the prefix `mcp__<server>__`, so a server cannot replace a Garuda tool.
- Descriptions and results are cleaned (terminal escape codes, control, invisible and Unicode tag
  characters), limited in size, and marked as untrusted for the model (`<mcp_result>`).
- Garuda offers no sampling, roots or elicitation, so a server cannot make model calls or ask
  you questions through Garuda.
- The evals never start MCP servers.

## Web fetch

`web_fetch` reads a web page (http or https) and gives it to the model as Markdown (0.2).

- The first fetch from a host asks you and shows the full URL. "Yes, allow <host> for this session"
  skips later questions for that host. Rules skip the question for good:
  `web_fetch(docs.python.org)`, or `web_fetch(*.github.com)` for its subdomains.
- An unusual URL (very long, or with a long token that could carry data from the session) always asks,
  also for an allowed host.
- A redirect to another host asks like a new fetch.
- Protection against server-side request forgery: Garuda resolves each host itself, checks every
  address (only public addresses; no private, loopback, link-local such as 169.254.169.254, or other
  special ranges, also as IPv4-mapped IPv6), and connects to exactly the checked address. Redirects
  are followed by hand (at most 5) and checked the same way.
- http is upgraded to https. URLs with a user name or password are refused. Garuda sends no cookies
  and no credentials, and it does not use a proxy.
- Limits: 5 MB per page (also after decompression), 30 s, text types only. HTML becomes Markdown
  without scripts, styles and navigation. Long pages come in parts (`start`, `max_chars`); a page is
  cached for 10 minutes.
- Page text is cleaned like MCP text and marked as untrusted (`<web_result>`).
- Settings: `"web": { "enabled": false }` removes the tool. `"web": { "allowLocalhost": true }` allows
  loopback addresses (for a local docs server); private network ranges stay blocked.
- The evals turn web_fetch off.

## Web search

`web_search` finds pages for a query (0.5). Set a key and it appears:

```sh
export BRAVE_API_KEY=...       # Brave Search, or:
export TAVILY_API_KEY=...      # Tavily
```

Or pick a backend in `~/.garuda/search.json`: `{ "provider": "brave" }`, `{ "provider": "tavily" }`, or
your own SearXNG server: `{ "provider": "searxng", "url": "http://localhost:8888" }` (turn on its JSON
format). Keys come only from environment variables; a project cannot configure search.

- The query leaves your machine, so each search shows the query and asks. "Yes, for this session" skips
  the question for later searches; `"permissions": { "allow": ["web_search"] }` skips it for good (and allows
  searches in plan mode).
- A query with a long token (it could be a key) is refused.
- Results are titles, URLs and short texts, marked as untrusted. The model reads pages with `web_fetch`.
- `"web": { "enabled": false }` removes both web tools. Details: [docs/lld/web.md](docs/lld/web.md).

### Claude's web search (0.6)

With a Claude model, the model can use Claude's own search tool, which runs on Anthropic's servers. Turn it
on with a `claude` section in `~/.garuda/search.json`:

```json
{ "claude": { "maxUses": 5 } }
{ "provider": "tavily", "claude": { "blockedDomains": ["example.com"] } }
```

- The search runs inside the model's reply, so Garuda cannot ask before each query. Choose once which
  web search you want, with `"use"` in `~/.garuda/search.json`: `"claude"` (Claude's search; your other
  backend stays the fallback for other models), `"provider"` (only your other backend) or `"off"`.
  `garuda init` asks it when Claude's search is set up and nothing is saved; without a saved choice,
  the chat asks once before the first task and saves the answer. No session asks again.
- `/search` shows what is in use. `/search claude|provider|off` switches for this session;
  `/search default claude|provider|off` changes the saved choice.
- It costs $10 per 1,000 searches, on top of the tokens. The usage line and `/usage` include it.
- `maxUses` (1–20, default 5) caps the searches per model request. `allowedDomains` or `blockedDomains`
  (not both) limit the sites.
- Your other backend (`provider`, or a key in the environment) is the fallback: for a model that is not a
  Claude model (for example after `/models`), or with `"use": "provider"`. Without one, `provider` is
  not offered.
- Custom agents whose tools allow `WebSearch` (or `web_search`) get it too, in the same session.
- The chat shows each search: `● web_search (Claude) <query>` and the number of results; Ctrl-O lists
  the pages.

## Scheduled jobs (0.7)

A plan can run later, with nobody at the keyboard: for example overnight.

1. Make a plan in plan mode (`/plan`, then your task). Each plan now ends with a `permissions` block: the
   file edits and network commands the build needs.
2. At "Build this plan?", choose "No, keep planning", and type `/schedule 01:00` (the time is optional).
   Garuda shows the approval list, where the job starts (your last commit, plus your uncommitted changes
   of tracked files) and its branch, and asks once.
3. In a terminal in the project folder: `garuda run <job-id> --at 01:00`. It waits, then builds the plan in
   its own worktree on the branch `garuda/job-<id>`. Your checkout does not change.

- The job asks nothing. Reads, commands in the sandbox and the calls in its list are allowed; any other call
  is denied, and the job goes on and reports it. You can edit the list (`"allow"`) in
  `.garuda/jobs/<id>.json` before the run.
- A job needs git and the OS sandbox. `node_modules` and `.venv` are linked from your checkout.
- At the end Garuda commits the changes on the job branch (no git hooks run) and writes a report:
  `.garuda/jobs/<id>.md`, also shown by `/jobs <id>`. Review with `git diff`, then `git merge
  garuda/job-<id>`, and remove the worktree.
- `/jobs` lists the jobs. Keep the Mac awake and on power while the terminal waits.
- `/jobs delete <id>` (0.11) asks, then removes the job file, report, log and worktree. An unmerged job
  branch may hold work: you choose to keep it or delete it too. A running job cannot be deleted.
- On macOS, `/schedule HH:MM` offers a launchd agent: the job then starts at that time also with no
  terminal open. It runs through your login shell (so your `.zshrc` gives it the API keys) under
  `caffeinate`, logs to `.garuda/jobs/<id>.log`, and sends a macOS notification at the end. If the Mac
  sleeps at that time, the job starts at the next wake (`sudo pmset schedule wake "<date>"` can wake it).
  `/jobs cancel <id>` removes the agent.
- With a Claude model, `/schedule` also asks whether the job should use the Batch API: half the token
  price, but each step waits for its batch: about 3 minutes in the first measurement, sometimes hours.
  A step that waits more than 20 minutes (`"stepLimitMinutes"`) runs on the normal API, and the next step
  tries the Batch API again. 15 minutes before the finish-by time (`"finishBy": "07:00"` in the job file)
  a job that still runs goes on with the normal API. The run prints the batch id and a line per minute
  of waiting.

### The night shift (0.11)

Each `/schedule` also puts the job in the project's night queue. `garuda night --at 01:00` waits, then
runs the queued jobs, up to 3 at a time (`--parallel n`, 1 to 10), each in its own worktree and with its
own log (`.garuda/jobs/<id>.log`). At the end it writes one digest, `.garuda/jobs/night-<date>.md`: a row
per job with its verdict, tests, files, cost and branch, and why the others need a look. `/jobs` shows
which jobs are in the queue. A job with its own launchd agent is not in the queue.

On macOS, `/schedule HH:MM` asks whether launchd should start **the whole night queue** at that time
(one agent per project, `garuda night` through your login shell under `caffeinate`, log
`.garuda/jobs/night.log`, a macOS notification at the end), **only this job**, or nothing. A later
`/schedule HH:MM` moves the queue's agent to the new time. The agent removes itself after the run;
`/jobs` shows it, and `/jobs cancel night` removes it.

### Proof of work (0.11)

Each job report starts with a verdict: **Ready to merge** or **Needs a look**. It rests on three things:

- **Tests before and after.** Garuda finds the test command (a `test` script in `package.json`, run with
  pnpm, yarn or npm by the lock file; else the Maven, Gradle or pytest command; else `node --test` when
  there are `*.test.js` files) and runs it in the sandbox
  at the job's base and again after the job. `"test"` in the job file changes or sets it.
- **Risk flags.** STOP: the job did not finish, or the tests fail after it. Look: no test command, test
  files deleted or changed, dependency or build files changed, CI or environment files changed, a large
  change, denied calls, tests that failed before and pass after.
- **A review.** The job's model works as a staff engineer. A second request to the same model, as a
  principal engineer who knows the project's stack, reads the request, the plan, the diff, the test
  results and the flags, and answers `VERDICT: ready | needs a look` with findings. It costs one model
  call (shown in the report); `"review": false` in the job file turns it off.

A STOP flag always means "Needs a look"; otherwise the review decides.

## Hooks

Hooks are your own commands that run around the agent's tool calls (0.2).

```json
{
  "hooks": {
    "preToolUse": [
      { "tools": ["bash(git push*)"], "command": "echo 'Pushes need a review first.' >&2; exit 2" }
    ],
    "postToolUse": [
      { "tools": ["edit_file", "write_file"], "command": "npx eslint \"$GARUDA_FILE\" >&2 || exit 2" }
    ]
  }
}
```

- Your own hooks go in `~/.garuda/hooks.json`. A project can add hooks in `.garuda/hooks.json`; Garuda
  shows every command and asks first, like for MCP servers. "Remember" pins the answer to a hash of
  the hooks; any change asks again.
- `tools` uses the permission rule syntax (`edit_file`, `bash(git push*)`, `mcp__github__*`).
  An empty list matches every tool. Keys: `command`, `tools`, `timeoutMs` (default 30000), `network`.
- `preToolUse` runs before the approval question. Exit 0 lets the call go on. Exit 2 blocks it, and
  stderr tells the model why. Any other failure (another exit code, a timeout) also blocks the call:
  a broken guard never lets a call through. A hook can block a call, never approve one.
- `postToolUse` runs after the call. Exit 2 adds stderr to the result as feedback for the model
  (for example lint errors). Other failures only show a warning.
- Hooks run in the OS sandbox, with no network unless `"network": true`. They get
  `$GARUDA_HOOK_EVENT`, `$GARUDA_TOOL`, `$GARUDA_FILE` (for file tools), `$GARUDA_COMMAND` (bash),
  `$GARUDA_URL` (web_fetch), and `$GARUDA_HOOK_INPUT`: a JSON file with the tool input (and the result
  for postToolUse).
- `/hooks` shows the active hooks. The evals run with no hooks.

## Permissions

Put rules in `.garuda/settings.json` in the project. Deny rules always win.

```json
{
  "executor": "auto",
  "permissions": {
    "allow": ["bash(pnpm test*)", "bash(git status)", "edit_file(src/**)"],
    "deny": ["bash(rm -rf*)", "bash(git push*)"]
  },
  "env": { "allow": ["NODE_ENV"] },
  "limits": { "maxSteps": 50, "tokenBudget": 20000000 },
  "model": {
    "contextWindow": 200000,
    "price": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
  }
}
```

- A rule is `tool` (every call) or `tool(pattern)`.
- File patterns are globs relative to the root. A name without `/` matches at any depth.
- Command patterns use `*` for any text. Garuda splits a command at `;`, `&&`, `||`, `|` and `$(…)`.
  A deny rule blocks the command when one part matches, also behind `sudo`, `env` or `VAR=value`.
  An allow rule must match every part as written: `bash(pnpm test*)` does not cover
  `NODE_OPTIONS=… pnpm test` or `sudo pnpm test`.
- Sensitive files (`.env*`, keys, `.npmrc`, `.aws/`, …) are blocked, also for reads, also through a
  symbolic link with another name. On macOS and Windows, path patterns ignore letter case
  (`.ENV` is `.env` there).
  An allow rule that names the file, for example `read_file(.env.example)`, unblocks it.
- Write tools never change files in `.git/`.
- Commands see only these environment variables: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`,
  `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TZ`, plus the names in `env.allow`. API keys stay out.
- With no terminal on stdin (a pipe or CI), Garuda cannot ask, so it denies calls that need approval.
- The project's file comes with the repository, so its parts that loosen safety need your yes first:
  `executor: "host"`, `permissions.allow`, `sandbox.writePaths`, `env.allow` and
  `web.allowLocalhost`. At startup the chat (and `-p` in a terminal) shows them and asks: yes for this
  run, yes and remember (pinned in `~/.garuda/trust.json`; a change asks again), or no. Without a yes,
  Garuda leaves those parts out and says so; the rest of the file (deny rules, limits, features)
  applies. A scheduled job uses them only when they are pinned. Settings that `garuda init` writes
  ask once at the next start too.

## Standalone binary

`pnpm package` builds one executable file, `bin/garuda`, for the machine you build on.
It holds Node and all of Garuda, so the target machine does not need Node.
It needs Node 25.5 or later to build (it uses `node --build-sea`).

```sh
pnpm package
./bin/garuda                 # greeting
./bin/garuda --version
sudo cp bin/garuda /usr/local/bin/   # optional: put it on your PATH
```

Notes:

- The binary is about 100–150 MB, because it contains the Node runtime.
- Build on each platform that you want to run on. A binary built on an Apple silicon Mac runs only on Apple silicon Macs.
- On macOS, the script signs the binary ad hoc (`codesign --sign -`), so it runs on the machine that built it.
- Homebrew's Node has single executables turned off. The script then downloads the official Node build of
  the same version from nodejs.org, checks its SHA-256 sum and keeps it in `~/.cache/garuda`.
  Set `GARUDA_SEA_NODE=/path/to/node` to use a Node binary of your choice, or `NODEJS_ORG_MIRROR` to use a mirror.

## Layout

| Folder | Holds |
| --- | --- |
| `src/model/` | Provider-neutral types, `ModelClient`, the Anthropic adapter, the fake model |
| `src/loop/` | `runAgent(session, deps)`: the agent loop, limits, loop guard; `replaySession` |
| `src/context/` | Compaction, the system prompt, and the loader of AGENTS.md, CLAUDE.md and GARUDA.md |
| `src/commands/` | Custom slash commands |
| `src/tools/` | `Tool<I, O>`, the registry, and the tools: `read_file`, `glob`, `grep`, `write_file`, `edit_file`, `bash`, `process_manager` |
| `src/permissions/` | Path guard (F15), rules, sensitive paths, settings, and the permission engine (F17–F20) |
| `src/sandbox/` | `Executor` interface, `ExecPolicy`, `HostExecutor`, `SeatbeltExecutor`, `BwrapExecutor`, `DaemonManager`. The only place that starts processes (N8) |
| `src/session/` | Session state, records, `SessionStore` (JSONL files), resume, redaction, read tracking |
| `src/app/` | `Runtime`: settings, executor, permissions and session for one process. The CLI and the evals share it |
| `src/cli/` | Entry point, chat mode, renderer, terminal approver, `garuda eval` |
| `src/evals/` | The eval suites (basic, hard, java, python), the shopkit repo generator, toolchain checks and the runner |
| `src/agents/` | Subagent execution (`child.ts`): the explore subagent (0.3), custom agents (0.5), and Mixture-of-Experts language specialists (0.17) |
| `src/lang/` | Language profiles: build and test commands, prompt notes and sandbox caches for Maven, Gradle and Python projects |
| `src/knowledge/` | The code index: `KnowledgeIndex`, `LanguageExpert`, the TypeScript/JavaScript expert |
| `scripts/` | Build helpers. `package.mjs` makes the standalone binary |
| `test/` | Vitest suites. `loop.test.ts`, `m2.acceptance.test.ts` and `m3.acceptance.test.ts`, `m4.acceptance.test.ts`, `m5.acceptance.test.ts` hold the milestone acceptance tests. `executorContract.ts` is the suite every executor must pass |

## Rules

- The loop gets all dependencies as arguments. It never imports the CLI.
- Only `src/model/anthropic.ts` imports the Anthropic SDK (N1).
- Only `src/sandbox/` may start processes (N8). Biome and a test enforce this.
- Strict TypeScript. No `any` in public interfaces (N7).
