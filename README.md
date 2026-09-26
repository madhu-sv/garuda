# Garuda

Garuda is a terminal coding agent. This is version 0.6.0-dev.
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
| 0.6: chat UX (Esc, multi-line, $EDITOR; @file, !cmd, completion; sessions and models in the chat; notifications, /diff), Claude's built-in search | In progress |

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
  `/init` (set up this folder, see below), `/editor`, `/diff` (see Undo), `/exit`. Your custom commands and
  skills run with `/name`.
- `/sessions` lists this project's sessions (newest first: time, first prompt, turns, cost, model).
  `/sessions <number or id>` continues one in the chat, as `--resume` does. Read tracking starts again.
- `/models` lists the known Claude models and the models in `~/.garuda/models.json`, with context window and
  price. `/models <number, id or opus|sonnet|haiku|fable>` switches the main model for the next turns of this
  chat. The session records the change; a new chat starts with `-m` or `GARUDA_MODEL` again. The prompt cache
  starts again; a smaller window makes Garuda compact the conversation first. Explore keeps the start model.
- `/export [file]` writes the conversation as Markdown in the working folder (default
  `garuda-<session id>.md`): prompts and answers in full, one line per tool call. It comes from the session
  file, so secrets are redacted. It never overwrites a file and never writes outside the folder.
- Esc or Ctrl-C during a task stops the task and kills its commands (Esc also drops queued lines). The
  chat goes on. A second Ctrl-C during the task exits Garuda at once; Esc never exits.
- New lines: end the line with `\` and press Enter, or press Alt+Enter (Option+Enter on a Mac with
  "Use Option as Meta"). Pasted text keeps its new lines and is never sent by itself.
- `@path` attaches a file or folder: `fix the bug in @src/cart.ts`. The file's text goes with your
  message (numbered, up to 2,000 lines) and counts as read, so the model can edit it at once; a folder gives
  its list of entries. The same rules as `read_file`: only files in the folder, no secrets (`.env`, keys).
  Garuda shows what it attached. A word after `@` that is not a path stays text.
- `!command` runs a command yourself, like the bash tool: in the sandbox with no question, deny rules and
  hooks apply. You see the output, and it goes to the model with your next message. Esc stops it.
- Tab completes `/commands` (built-in, your own, skills) and `@paths`; with several matches it lists them.
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
  y (once), a (session), n or Esc (deny).
- `GARUDA_PLAIN=1` turns Ink off. Pipes, `-p`, the evals and the standalone binary always use plain output.
- Notifications: when an approval waits during a task, and when a task that ran 10 s or longer ends, Garuda
  tells you. In iTerm2, Ghostty and WezTerm it sends a desktop notification (the OSC 9 escape code); in other
  terminals and in tmux it rings the bell. `GARUDA_NOTIFY=off|bell|osc9|auto`, or
  `"notifications": { "channel": "off", "afterSeconds": 30 }` in `.garuda/settings.json`, changes it.
  In iTerm2 the notification needs "Send escape sequence-generated alerts" (Settings › Profiles › Terminal),
  which is on by default.
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
  mode. The footer shows `PLAN`.
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
```

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

The runner approves every call except its deny rules (`rm -rf`, `sudo`, `git push`, `curl`, `wget`).
Commands run in the scratch folders, in the OS sandbox when there is one (`--executor auto|os|host`). Results and session files go to
`.garuda/evals/<run-id>/`.

`pnpm startup` checks that startup takes less than 1 s (N3). The Anthropic SDK and the prompt library
load on first use, not at startup.

## Code index (local knowledge)

For JS/TS, Garuda keeps a local code index. It answers code questions on this machine, with no model call:

- Tools for the agent (read-only, no approval), chosen with `"codeIndex"` in `.garuda/settings.json`:
  `"off"` (default), `"lookup"` (`find_symbol`, `find_references`) or `"all"` (also `repo_map`).
  The default is off because an A/B eval (hard suite, 3 runs per arm) showed the full set cost about
  20% more with no fewer steps. `find_references` did help on "who uses X" tasks.
- Chat commands for you: `/where X`, `/refs X`, `/map [folder]`.
- The code graph (files, exports, imports) is cached in `.garuda/index/code-graph.json` by file hash.
  References come from the TypeScript 6 language service, which loads on first use.
- Files follow `.gitignore`. Sensitive files are never indexed.
- Other languages come later, each with its own expert behind the `LanguageExpert` interface (`src/knowledge/`).

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
- has no network (localhost works on macOS).

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
- On Linux, install bubblewrap (`sudo apt install bubblewrap`). Some systems block the user namespaces
  that it needs; Garuda then falls back to the host and says why.
- Limit on Linux: a protected path that does not exist yet (for example `.git/hooks` in a folder with no
  `.git`) is not protected.

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
  A deny rule blocks the command when one part matches. An allow rule must match every part.
- Sensitive files (`.env*`, keys, `.npmrc`, `.aws/`, …) are blocked, also for reads.
  An allow rule that names the file, for example `read_file(.env.example)`, unblocks it.
- Write tools never change files in `.git/`.
- Commands see only these environment variables: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`,
  `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TZ`, plus the names in `env.allow`. API keys stay out.
- With no terminal on stdin (a pipe or CI), Garuda cannot ask, so it denies calls that need approval.

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
| `src/tools/` | `Tool<I, O>`, the registry, and the tools: `read_file`, `glob`, `grep`, `write_file`, `edit_file`, `bash` |
| `src/permissions/` | Path guard (F15), rules, sensitive paths, settings, and the permission engine (F17–F20) |
| `src/sandbox/` | `Executor` interface, `ExecPolicy`, `HostExecutor`, `SeatbeltExecutor`, `BwrapExecutor`. The only place that starts processes (N8) |
| `src/session/` | Session state, records, `SessionStore` (JSONL files), resume, redaction, read tracking |
| `src/app/` | `Runtime`: settings, executor, permissions and session for one process. The CLI and the evals share it |
| `src/cli/` | Entry point, chat mode, renderer, terminal approver, `garuda eval` |
| `src/evals/` | The eval suites (basic, hard, java, python), the shopkit repo generator, toolchain checks and the runner |
| `src/agents/` | The explore subagent: a read-only child agent loop behind one tool |
| `src/lang/` | Language profiles: build and test commands, prompt notes and sandbox caches for Maven, Gradle and Python projects |
| `src/knowledge/` | The code index: `KnowledgeIndex`, `LanguageExpert`, the TypeScript/JavaScript expert |
| `scripts/` | Build helpers. `package.mjs` makes the standalone binary |
| `test/` | Vitest suites. `loop.test.ts`, `m2.acceptance.test.ts` and `m3.acceptance.test.ts`, `m4.acceptance.test.ts`, `m5.acceptance.test.ts` hold the milestone acceptance tests. `executorContract.ts` is the suite every executor must pass |

## Rules

- The loop gets all dependencies as arguments. It never imports the CLI.
- Only `src/model/anthropic.ts` imports the Anthropic SDK (N1).
- Only `src/sandbox/` may start processes (N8). Biome and a test enforce this.
- Strict TypeScript. No `any` in public interfaces (N7).
