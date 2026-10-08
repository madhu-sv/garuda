# Changelog

## 0.16.2 (unreleased)

- The system prompt names Garuda's version and the model, so "which model are you?" gets a true
  answer. After `/models`, the next message tells the model about the switch; the system prompt
  stays the same bytes, so the prompt cache stays valid.
- Website: a share image and share tags (LinkedIn, X and chat previews) on every page, structured
  data on the landing page, and a place for the Google Search Console tag (`site/src/seo.ts`; see
  docs/release.md). More npm keywords.

## 0.16.1 (2026-10-06)

- `garuda acp` offers its sign-in (Terminal Auth) also to clients that declare the capability in
  its older form, `_meta["terminal-auth"]`. The ACP Registry's checker sends only that form, so
  0.16.0 answered it with no sign-in method and failed the registry's auth check.

## 0.16.0 (2026-10-06)

Setup for editors and the ACP Registry (design: [docs/lld/setup.md](docs/lld/setup.md)).

- Stored provider keys: Garuda reads `~/.garuda/credentials` (JSON, key name → key) when no
  environment variable sets the key. It reads the file only when it is a regular file (not a link),
  owned by you, with mode 0600; else it ignores the file with a warning. The key never enters
  Garuda's environment, and the redactor knows it. `garuda setup` writes this file.
- Commands in the OS sandbox cannot read `~/.garuda/credentials` (macOS and Linux).
- `"default"` in `~/.garuda/models.json`: the model when neither `--model` nor `GARUDA_MODEL` names
  one.
- The redactor removes every provider key that Garuda keeps, also one whose variable name does not
  look secret (a custom provider's `apiKeyEnv`).
- `garuda setup`: choose a provider and a model, enter the key once (hidden input), check it with
  one free request to the provider, then store the model as the default and the key in
  `~/.garuda/credentials`. `--show` shows where each key comes from (masked); `--forget [NAME]`
  removes stored keys. With no terminal, it stops with a message.
- The messages for a missing model or key name `garuda setup`.
- `garuda acp`: Terminal Auth. An editor that can run it (`auth.terminal`) gets a "Set up Garuda"
  method; it runs `garuda acp setup` in a terminal. A session with no model or no key fails with
  ACP's "auth required", so the editor offers the setup. The setup is read again for each new
  session: no restart after `garuda setup`.
- Native Windows: `garuda acp` sessions and `garuda setup` stop with a message to use WSL.
- Docs: `garuda setup` in the quick start, the landing page, the README and the Editors page; editor
  entries need no API key in their settings. Tested live in Zed 1.22: with no model and no key, Zed
  offered the setup, ran it in a terminal, and the next thread worked with no restart.
- `-p --output-format stream-json`: `apiKeySource` in `system/init` is `credentials` for a stored
  Claude key.

## 0.15.0 (2026-10-06)

Garuda in your editor. Version 0.15.0 is not the old "0.15" branch label of the status table (code
intelligence), which shipped in 0.14.0.

### Editors

- `garuda acp`: Garuda as an agent for editors over the Agent Client Protocol (v1): VS Code (with
  the "ACP Client" extension), Zed, JetBrains, Neovim, Emacs. One runtime per editor session, with
  the same permission engine, OS sandbox, team policy, hooks and audit log as the terminal.
- Approval questions name their tool call (`callId`), and file writes carry the whole change, so an
  editor shows each question next to the right call, with its own diff view.
- A stop in the editor names what it ended: each stopped tool call shows as failed, with a line
  such as "Garuda: $ sleep 60 cancelled." (or "the turn was cancelled." when no call ran). A call
  that has not reported within 3 s of the stop ends as failed, so none stays "running".
- Docs: the website's Editors page (VS Code with ACP Client, Zed, other ACP editors). Tested live
  in VS Code and Zed on macOS.

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
