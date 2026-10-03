# Init (`src/init/`)

## Purpose

`garuda init` and `/init` set up a folder for Garuda (0.5):

1. **Migrate.** Read the files of other coding agents, show what goes where, and write new files after one yes.
2. **git.** Offer `git init` when the folder is not a repository.
3. **The init turn.** Give the model a prompt. In a code project, it reads the code and writes or
   improves `AGENTS.md`. In an empty folder, it asks what to build first.

Steps 1 and 2 run no model. The init turn uses the normal tools, so each file write shows its diff and asks.

OpenCode has `/init` too (it writes AGENTS.md). It does not import MCP servers, commands or rules from
other agents. Garuda does both.

## Files

| File | Role |
| --- | --- |
| `types.ts` | `ImportItem`: `mcp`, `command`, `rule`, `instructions`, `skipped`. Each has `agent`, `source` and `notes`. |
| `convert.ts` | Pure conversions: names, env values, Markdown and TOML commands, Claude Code and OpenCode rules, JSONC. |
| `sources.ts` | One reader per agent. Reads only; runs nothing. `loadToml()` loads the TOML reader on demand (N3). |
| `plan.ts` | `buildPlan` (where each item goes), `previewText`, `applyPlan`. |
| `detect.ts` | `folderKind` (code, notes, empty) and `initTip` (the hint on the chat start banner). |
| `run.ts` | `runInit`: the three steps; `initPrompt`. |

## What Garuda reads

| Agent | MCP servers | Commands | Rules | Instructions |
| --- | --- | --- | --- | --- |
| Claude Code | `.mcp.json`, `~/.claude.json` (top level and this project) | `.claude/commands`, `~/.claude/commands` | `.claude/settings.json`, `.claude/settings.local.json` | CLAUDE.md is read natively |
| OpenCode | `opencode.json(c)`, `~/.config/opencode/opencode.json(c)` | `.opencode/command(s)`, the `command` key | `permission` (project file) | AGENTS.md is native |
| Codex | `.codex/config.toml`, `~/.codex/config.toml` | `~/.codex/prompts` | – | AGENTS.md is native |
| Gemini CLI | `.gemini/settings.json`, `~/.gemini/settings.json` | `.gemini/commands/**/*.toml` | – | `GEMINI.md` |
| Tabnine | `.tabnine/agent/settings.json`, `.tabnine/mcp_servers.json`, `~/.tabnine/agent/settings.json` | `.tabnine/agent/commands/**/*.toml` | – | `TABNINE.md`, `.tabnine/guidelines/` |
| Cursor | `.cursor/mcp.json`, `~/.cursor/mcp.json` | – | – | `.cursorrules`, `.cursor/rules/*.mdc` |
| Copilot | – | – | – | `.github/copilot-instructions.md`, `.github/instructions/` |

A missing file gives nothing. A file that does not parse gives one `skipped` item, and the rest is still read.
At most 200 files per command folder.

## Conversions

| From | To | Rule |
| --- | --- | --- |
| Server name | `[a-z0-9_]`, up to 32 | Lower case; other characters become `_`. No valid name: skipped. |
| stdio server | `{command, args, env}` | `cwd` is left out (note). A note says it runs in the sandbox with no network. |
| Remote server | `{url}` | Streamable HTTP only. Claude `type: "sse"` and Gemini `url` (without `httpUrl`) are SSE: skipped. The URL must pass `checkServerUrl` (project servers: https and a public address). Headers are not copied (note): Garuda signs in with OAuth. |
| Disabled server | `enabled: false` | It stays off. |
| env value | `${VAR}` stays; OpenCode `{env:VAR}` becomes `${VAR}` | A literal value under a secret-like name (KEY, TOKEN, SECRET, PASS, CRED, AUTH) is **not copied**: it becomes `${NAME}`, with a note. Codex `env_vars` become `${VAR}`. |
| Server args | copied | An argument that looks like a secret (`--api-key`, `sk-…`, `ghp_…`) gives a note to check the new file. |
| Markdown command | Garuda command file | `description` and `argument-hint` stay; other front-matter keys are left out (note). `` !`cmd` `` and `@file` stay as text (note). |
| TOML command | Garuda command file | `prompt` is the body, `description` stays, `{{args}}` becomes `$ARGUMENTS`. Subfolder `git/commit.toml` becomes `/git:commit`. |
| Claude Code rule | Garuda rule | `Bash(x:*)` and `Bash(x *)` → `bash(x*)`; `Read(p)` → `read_file(p)`; `Edit`/`Write`/`MultiEdit(p)` → `edit_file(p)` and `write_file(p)`; `WebFetch(domain:h)` → `web_fetch(h)`; `mcp__…` stays. Others: skipped. |
| OpenCode `permission` | Garuda rules | `bash`, `edit`, `read`, `webfetch`; `allow` and `deny` only (`ask` is Garuda's default). |
| Instruction files | – | Not copied. The init turn reads them and carries over what still applies into AGENTS.md. |

Not imported, with a line in the preview: hooks (another format), personal permission rules (Garuda has
project settings only). Claude Code skills (`.claude/skills`, `~/.claude/skills`) need no import: Garuda reads
them where they are (0.5, see [skills.md](skills.md)).

## The plan: new files only

`buildPlan(items, {root, home, defaults})`:

- MCP servers: one new `mcp.json` per scope (`~/.garuda/mcp.json`, `.garuda/mcp.json`). If the file exists,
  its servers are listed as "add it there by hand". The first server with a name wins.
- Commands: one new file each, in `~/.garuda/commands/` or `.garuda/commands/`. A built-in name or an
  existing file: skipped.
- Rules and defaults: a new `.garuda/settings.json` with `executor: "auto"`, the rules, `undo.enabled: true`
  and `lsp.enabled: false`. If the file exists: the rules are listed as "add it there by hand".
- `.gitignore`: the only change to an existing file. Garuda adds the missing lines of
  `.garuda/sessions/`, `.garuda/index/`, `.garuda/evals/` under a comment.

`applyPlan` creates new files with the `wx` flag: a file that appeared after the preview is not replaced.

The preview groups the lines per agent: `+` goes (with `!` notes), `-` does not (with the reason). Then it
lists the files, `new` or `append`.

## Trust

- Init only reads other agents' files. It starts no server and runs no command, except `git init` after a yes.
- Imported project servers and commands are ordinary project files. They still need consent the first
  time (`TrustStore`), like any project server or command.
- Secrets are not copied (see env values). Headers are not copied.
- A project URL server must be https on a public address, the same rule as `.garuda/mcp.json`.

## The folder and the prompt

`folderKind(root)`:

- `code`: a build file at the root (`package.json`, `pom.xml`, `pyproject.toml`, `go.mod` …), or a source
  file up to three folder levels deep.
- `notes`: files, but no code. `empty`: no files.
- Dot folders and dependency folders (`node_modules`, `target`, `dist` …) are skipped. At most 5 000 entries.

`initPrompt(kind, otherFiles)`:

- `code`: read with glob, grep and read_file; do not change code; create or improve AGENTS.md with
  "Build and test", "Structure", "Conventions", "Notes"; only checked facts; no secrets.
- `empty` and `notes`: ask the user what to build (language, build tool, test tool), with defaults; no files
  in this turn; then AGENTS.md and an offer of a skeleton.
- Other agents' instruction files are named, so the model reads them.

In plan mode, `/init` adds a line: the init turn can only read; `/build` lets it write AGENTS.md.

Web search (0.14): when `~/.garuda/search.json` has a `claude` section and no `use`, init asks once
which web search to use (Claude's search, the other provider when there is one, or none) and saves the
answer as `use` (`saveSearchUse`). It is a user setting, for every project.

`initTip(root)` for the chat start banner: another agent's files and no `.garuda` → "Found files of …";
no AGENTS.md, CLAUDE.md or GARUDA.md → a hint to type `/init`; else nothing.

## Entry points

- `garuda init [-m model]`: starts the chat with `/init` as the first line (`firstInput`), in the Ink chat and
  in the plain REPL.
- `/init` in the chat: `Runtime.init(signal)` runs steps 1 and 2 and returns the report and the prompt;
  the chat runs the prompt as a turn.

## Tests

`test/init.test.ts`: each conversion; a folder with files of all seven agents (servers, commands, rules,
instructions, skipped items, no secret in the output); broken files; a private project URL; the plan
(the written files load with `loadMcpConfig`, `loadCommands` and `parseSettings` with no problems);
new files only (existing files unchanged, `.gitignore` lines added once); duplicate names; a file that
appears after the plan; `folderKind`, `initTip` and `initPrompt`; `runInit` with yes and no (git init runs
through the HostExecutor); `/init` through `runCommand`; `garuda init` in the plain REPL.
