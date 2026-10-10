---
title: "Introducing Garuda: an open-source coding agent with an OS sandbox"
description: "Garuda is an open-source coding agent for the terminal and for editors. Commands run in an OS sandbox that writes only in your project, edits ask first, and every decision goes to an audit log. It works with Claude, OpenRouter or local models."
date: 2026-10-08
author: Madhusudhan Vasanth Kumar
---

*Corrected on 10 October 2026: an earlier version said that every change asks first. Edits do, but
commands in the sandbox run with no question: they can change project files, within the sandbox's
limits. The list below now says exactly what each limit does. Thanks to a reviewer who pointed it
out.*

A coding agent reads your code, edits files and runs commands on your machine. That is what makes it
useful. It is also what makes it risky: one wrong command, or one instruction hidden in a file that
the agent reads, and the agent acts with all of your rights.

I started Garuda to learn what goes on under the hood of coding agents: the loop, the tools and the
harness that let engineers hand parts of the software lifecycle to a model. I wanted to build each
part myself, not only read about it, and to share what I learned along the way. That is why the
[design documents](/garuda/docs/design/) are public, next to the code: the architecture, the
high-level design, and a low-level design for each component.

The deeper I went, the clearer one lesson became. The hard part is not to make the agent act. The
hard part is to decide what it may do, and to make that decision hold when the model is wrong or a
file tries to trick it.

Garuda is my answer to that: an open-source coding agent where the limits come from the operating
system, not from the model's good behaviour. It is free, Apache-2.0, and it runs in your terminal,
in VS Code and in Zed.

## The limits, exactly

- **Commands run in an OS sandbox.** Seatbelt on macOS, bubblewrap on Linux. A command can write
  only in the project, temp folders and package caches. Your SSH keys, cloud credentials and other
  home secrets stay unreadable, and there is no network unless you open it. Inside the sandbox, a
  command runs with no question, so it can change project files; `/undo` restores what a turn
  changed, commands included. A command outside the sandbox always asks. Without a sandbox, each
  command asks.
- **Edits ask first.** An edit shows its diff, and you allow it once, for the session, or not at all.
  You can also accept single hunks. Plan mode only reads.
- **The network is closed by default.** When you open it, commands reach only the hosts that you
  list, through Garuda's own proxy.
- **A team policy that a project cannot loosen.** A managed file sets denied commands and paths, a
  required sandbox and allowed models. A cloned repository cannot change it.
- **An audit log with a hash chain.** Every permission decision and tool run goes to a log outside the
  project, with secrets redacted. `/audit verify` finds a changed or inserted line.
- **Consent for project content.** Hooks, MCP servers, skills and settings from a repository ask once,
  and the answer is pinned to a hash. A change asks again.

## Your model, your choice

Garuda works with Claude, with OpenRouter, and with local models through Ollama, LM Studio,
llama.cpp, vLLM or any OpenAI-compatible server. A local model costs nothing and keeps the code on
your machine.

Setup takes two commands:

```sh
npm install -g @garuda-agent/garuda    # or Homebrew: see the Install page
garuda setup                           # pick a provider and a model, enter the key once
garuda                                 # chat in your project
```

`garuda setup` checks the key with one free request and stores it in a file that only you can read.
Commands in the sandbox cannot read it.

## In your editor

`garuda acp` speaks the Agent Client Protocol, so Garuda works in Zed, in VS Code with the ACP Client
extension, and in other ACP editors. The editor shows the conversation, the tool calls and the diffs.
Garuda keeps the same sandbox, policy and audit log as in the terminal. In Zed, a new user signs in
from the editor: Zed runs the setup in a terminal, and the next thread just works.

## How I test it

- About 900 tests run with a fake model and no network. A test also proves each security rule: I
  remove the rule, and its test must fail.
- Eval suites measure real tasks: pass rate, steps, tokens and cost. Garuda can also build a
  benchmark from your own repository's git history.
- Before the 0.14 release, Garuda reviewed its own code, one area at a time, in plan mode.
  [I wrote about that review](/garuda/blog/garuda-reviews-garuda/).
- A feature without a measured gain stays off by default. For example, the code index for the model
  showed no gain in an A/B test, so it is off for the model.

## What it does not do yet

- Native Windows is not supported. Use WSL.
- Stored keys are in a private file, not in the OS keychain yet.
- In editors, the terminal's own commands (`/undo`, `/diff`) are not available yet.

## Try it

- Website and docs: https://madhu-sv.github.io/garuda/
- Code: https://github.com/madhu-sv/garuda
- Install: `npm install -g @garuda-agent/garuda`

Issues and pull requests are welcome. I especially want to hear where Garuda asked too much, too
little, or at the wrong moment.
