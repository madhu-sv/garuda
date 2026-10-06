# Changelog

## 0.15.0 (not released)

### Editors

- `garuda acp`: Garuda as an agent for editors over the Agent Client Protocol (v1): VS Code (with
  the "ACP Client" extension), Zed, JetBrains, Neovim, Emacs. One runtime per editor session, with
  the same permission engine, OS sandbox, team policy, hooks and audit log as the terminal.
- Approval questions name their tool call (`callId`), and file writes carry the whole change, so an
  editor shows each question next to the right call, with its own diff view.

## 0.14.1 (2026-10)

The first version on npm (`@garuda-agent/garuda`) and Homebrew (`madhu-sv/garuda/garuda`). It fixes
the open findings of Garuda's own review: the cli and extensions areas are new, and the low findings
of the other areas are closed. Each fix has a test that fails without it.

### Install

- npm: `npm install -g @garuda-agent/garuda`. Published from the release workflow with npm trusted
  publishing, with provenance.
- Homebrew: `brew tap madhu-sv/garuda`, `brew trust --formula madhu-sv/garuda/garuda`, then
  `brew install garuda`.

### Security

- Approvals show hidden characters in a command (controls, invisible and bidirectional
  characters), with a warning line. A carriage return or an escape code can no longer make a
  command look like another one.
- Eval checks run the agent's code in the run's OS sandbox, not on the host.
- Instruction files and `.garuda/memory.md` are read only when their real path is in the root.
- A project's formatter commands need the user's yes at startup, and the team policy checks them.
- Hook commands show as one clean line in the consent and in `/hooks`.
- Skill descriptions and MCP tool schemas cannot carry Garuda's markers.
- MCP: a project server's sign-in page may not be plain http on this machine; the consent warns
  about secrets taken by `${NAME}` and about write paths outside the project.
- Job links must be single folder names.
- The jdtls install stops when its checksum file is missing.

### Fixes

- Parallel eval tasks no longer kill each other's commands. All runtimes shared one sandbox
  executor, so a task that ended stopped the checks and commands of the others. Each runtime now
  has its own executor.
- A failed subagent still reports its tokens and cost; a child journal has one end record;
  children get the parent's diagnostics and formatters.
- The compaction summary call is retried after a dropped connection.
- A model client that fails to start is not cached.
- `grep` runs its pattern in a worker thread: a pattern that backtracks badly no longer blocks
  Garuda.
- `web_fetch` keeps at most 50 pages in its cache.
- Two MCP servers with the same tool name no longer stop every MCP start.
- Approvals ask one question at a time; the Ink chat drops keys for 400 ms after a question
  appears, so type-ahead cannot answer it.
- A job never stays "running" after `garuda run` stops.
- Plain chat: Ctrl-C during a `!command` stops the command, not Garuda.
- Arguments of commands and skills are inserted once: `$5` or `$&` stay as typed.
- `/init` skips symbolic links in a project's command folders.

### Known limits

See the README, under the status table.

## 0.14.0 (2026-10-03)

The 0.14–0.17 branches after the merge gate and Garuda's review of seven areas (knowledge,
permissions, tools, sandbox, audit, loop, agents). See
[docs/quality-baseline/validation-record.md](docs/quality-baseline/validation-record.md).
