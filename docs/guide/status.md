# Status and known limits

What each release added, and the known limits of this version.

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
| 0.14: sandbox launch probe, core modularization, background daemons (opt-in), interactive patch staging (W4) | Done (0.14.0) |
| 0.15: multi-language code intelligence (Python, Java, TS/JS, caller candidates, impact, /callers, /defs, /impact, ast_query) | Done (0.14.0) |
| 0.16: language plugins (Go and Rust built in, user plugins in ~/.garuda/languages, /languages; project plugins not loaded) | Done (0.14.0) |
| 0.17: Mixture-of-Experts subagents (opt-in), team policy and audit log (W5) | Done (0.14.0) |
| Editors over the Agent Client Protocol (`garuda acp`: VS Code with an extension, Zed, JetBrains, Neovim, Emacs) | Done (0.15.0) |
| `garuda setup` (model and stored key) and the editor sign-in (ACP Terminal Auth) | Done (0.16.0) |

The rows labelled 0.14–0.17 are branch labels, not versions: the "0.15" and "0.16" branches (code
intelligence, language plugins) shipped in 0.14.0. The last two rows are versions 0.15.0 and 0.16.0.

The 0.14–0.17 rows were built on stacked branches that were never released. They ship together as
0.14.0 after the merge gate: the high findings of the branch review are fixed (policy source, audit
log, hunk approval U0, daemons, MoE, project plugins), and features with no measured gain are off by
default (MoE, daemons). G02 to G08 are fixed too. The open gap G09 is listed in
[docs/quality-baseline/issue-register.md](../quality-baseline/issue-register.md). The section
headings in the user guide keep the branch labels (0.14–0.17).

Before 0.14.0, Garuda reviewed its own code with Fable 5.1, one area at a time (knowledge,
permissions, tools, sandbox, audit, loop, agents), in plan mode. 0.14.1 adds the cli and extensions
areas and fixes the open findings of all nine areas (see [CHANGELOG.md](../../CHANGELOG.md)). Known limits
in 0.16.1:

- G09: project language plugins are not loaded (no consent flow for their imports yet).
- Token budget: a call's reservation is an estimate (about 4 characters per token, plus the output
  limit), so a provider that counts more input tokens than the estimate can pass the cap by that
  difference.
- Audit log: without the checkpoint (`"audit": { "checkpoint": true }`, off by default), lines cut
  from the end of a file, or a removed file, are not detected.
- On macOS, secret-named variables other than the provider API keys stay in Garuda's own environment.
- Build tool caches that the sandbox may write (`~/.gradle/wrapper`, `jdks`, `native`, `caches`,
  `~/.m2/wrapper`) hold programs that a build runs later outside the sandbox. They stay writable, because
  `./gradlew` needs them in the sandbox; a sandboxed command could change them.
- The jdtls download is checked against the `.sha256` file of the same server, not a pinned hash.
- Editors (`garuda acp`): Garuda's session history is not in the editor (no `session/load`), the
  editor's MCP servers are not started, Garuda reads saved files (not unsaved buffers), the terminal's
  own commands (`/undo`, `/diff` …) are not available, and an edit is approved as a whole (no hunks).
- Stored keys are in a file (`~/.garuda/credentials`, mode 0600, hidden from the sandbox), not in the
  OS keychain yet. Keep the file out of backups and dotfile sync.
- Native Windows is not supported; use WSL.
