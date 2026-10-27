# Garuda

[![CI](https://github.com/madhu-sv/garuda/actions/workflows/ci.yml/badge.svg)](https://github.com/madhu-sv/garuda/actions/workflows/ci.yml)

Website and docs: https://madhu-sv.github.io/garuda/

Garuda is a coding agent for the terminal, and for editors over the Agent Client Protocol. It reads
and edits your code, runs commands in an OS sandbox, and keeps an audit log of its permission
decisions. It works with Claude and with OpenAI-compatible models, local ones too. This is version
0.17.0. Release notes: [CHANGELOG.md](CHANGELOG.md).

## What Garuda does on your machine

- `read_file`, `glob` and `grep` run with no question.
- `write_file` and `edit_file` show a diff first. You allow once, allow for this session, or deny.
- Commands (`bash`) run in an OS sandbox when your machine has one: Seatbelt on macOS, bubblewrap
  on Linux. There they run with no question, but they can write only in the project, temp folders
  and package caches, cannot read secrets in your home folder (such as `~/.ssh`), and have no
  network unless you open an allowlist. So a command can change project files without a question;
  `/undo` restores the files in its snapshot (ignored files, such as build output, are not in it).
- A command outside the sandbox asks first, unless one of your allow rules covers it. The strict
  profile forbids it. Without a sandbox, each command asks first, unless one of your allow rules
  covers it.
- With staged commands (0.17, off by default), a sandboxed command
  runs in a copy of the project, and its changes reach the project only after you apply them.

The details: [Sandbox, permissions and policy](docs/guide/safety.md). The known gaps:
[Status and known limits](docs/guide/status.md) and the
[issue register](docs/quality-baseline/issue-register.md).

## Install

You need Node 22.23.4, 24.22.1 or 26.12.1, or a later release of the same line: the latest security release of a supported line (Homebrew installs it). Garuda
warns at start on an older Node.

```sh
npm install -g @garuda-agent/garuda
```

Or with Homebrew (macOS and Linux). Homebrew loads a formula from a third-party tap only after you
trust it, so trust the Garuda formula first:

```sh
brew tap madhu-sv/garuda
brew trust --formula madhu-sv/garuda/garuda
brew install garuda
```

To build from source, see [CONTRIBUTING.md](CONTRIBUTING.md). Native Windows is not supported; use
WSL.

## Quick start

```sh
garuda setup                            # once: pick a provider and model, enter the key
garuda                                  # chat in the current folder
garuda -p "Explain what this repo does" # run one task and exit
echo "Explain this repo" | garuda       # the same, from stdin
```

`garuda setup` stores the model in `~/.garuda/models.json` and the key in `~/.garuda/credentials`
(mode 0600; commands in the sandbox cannot read it). `ANTHROPIC_API_KEY` and `GARUDA_MODEL` in the
environment still work and win.

## User guide

| Page | What it covers |
| --- | --- |
| [Install and first run](docs/guide/getting-started.md) | Install, `garuda setup`, the chat, one task, JSON output for scripts, the standalone binary. |
| [Models](docs/guide/models.md) | Claude, OpenAI-compatible providers, local models, prices and context windows. |
| [Chat, sessions and undo](docs/guide/chat.md) | The chat's keys and commands, sessions, limits, context, plan mode, undo, the todo list. |
| [Editors](docs/guide/editors.md) | Zed, JetBrains, Neovim, Emacs and VS Code over the Agent Client Protocol. |
| [Project instructions, commands, skills and agents](docs/guide/projects.md) | `garuda init`, custom slash commands, skills, custom agents, subagents, Java and Python projects. |
| [Sandbox, permissions and policy](docs/guide/safety.md) | The OS sandbox, the network allowlist, staged commands, permissions, hooks, the team policy, the audit log. |
| [MCP, web and code intelligence](docs/guide/tools.md) | MCP servers, web fetch and search, the code index, language plugins, LSP diagnostics, formatters. |
| [Scheduled jobs and the night shift](docs/guide/jobs.md) | Plan now, build later on its own branch, with tests before and after and a review. |
| [Evals](docs/guide/evals.md) | Measure a model or a setting on eval tasks, also tasks from your repo's history. |
| [Status and known limits](docs/guide/status.md) | What each release added, and the known limits of this version. |

Design documents: [docs/](docs/README.md) (architecture, high-level design, low-level design per
component). The requirements doc defines the scope; code, tests and commits refer to its IDs
(F1–F26, N1–N8).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: how to build, test and
send a pull request. Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md). To
report a security problem, see [SECURITY.md](SECURITY.md); do not open a public issue for it.

## License

Garuda is licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE).
