# Project instructions, commands, skills and agents

`garuda init`, custom slash commands, skills, custom agents, the explore subagent, language specialists.

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
Imported project servers and commands still ask for consent the first time. Details: [docs/lld/init.md](../lld/init.md).

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
  turns them off. Details: [docs/lld/skills.md](../lld/skills.md).

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
  off. Details: [docs/lld/agents.md](../lld/agents.md).

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

## Mixture-of-Experts (MoE) subagent dispatch and /experts (0.17)

Garuda features an autonomous Mixture-of-Experts (MoE) dispatch architecture for polyglot codebases:

- **Specialist profiles**: Dedicated subagents for Go, Rust, Python, Java, and TypeScript equipped with language-idiomatic prompts, toolchain testing commands (`cargo test`, `go test ./...`, `pytest`, `mvn test`, `pnpm test`), and the code index tools.
- **Dynamic delegation**: The primary orchestrator agent can invoke `delegate_expert({ language, task, files })` to dispatch complex language-specific tasks to child subagents. The child subagent runs with the code index tools (`find_symbol`, `find_references`, `find_callers`, `impact_analysis`, `ast_query`, `repo_map`; only JS/TS uses a language service, the other languages use heuristic matching marked approximate), executes language tests, and returns a synthesized report without cluttering the primary context window.
- **Chat command**: `/experts` lists all available language specialists, their active test commands, and their active status / indexed file counts.
- **Banner & Observability**: The startup banner features a dedicated `subagents` row (`subagents: explore · 5 MoE experts (Go, Rust, Python, Java, TS)`). In session, `/session` provides a full breakdown of active subagents, agents, skills, and tools.
- **Configuration**: off by default (no measured gain yet). Turn it on with `"moe": { "enabled": true }` in
  `.garuda/settings.json`; `subagents` alone does not turn it on. One `delegate_expert` call runs at a
  time, because a specialist can write files (merge gate, G05).

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
