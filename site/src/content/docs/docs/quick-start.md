---
title: Quick start
description: Your first session with Garuda.
---

## 1. Choose a model

Set a key and a model. With Claude:

```sh
export ANTHROPIC_API_KEY=...
export GARUDA_MODEL=claude-sonnet-5
```

With a local model, no key is needed, for example `export GARUDA_MODEL=ollama/qwen3-coder:30b`.
See [Models](/garuda/docs/guide/#models) for other providers.

## 2. Start a chat in your project

```sh
cd ~/my-project
garuda          # from a source build: node ~/garuda/dist/cli/index.js
```

Ask for a task, for example "Fix the failing test in src/cart.ts". Garuda reads files with no
question. It shows the diff of each edit and asks first. Commands run in the sandbox with no
question; a command outside the sandbox always asks.

Useful in the chat:

- `@path` attaches a file: `explain @src/cart.ts`.
- `!command` runs a command yourself, in the sandbox.
- `/plan` switches to plan mode: Garuda only reads, and ends with a plan.
- `/undo` takes back the last turn, with its file changes.
- `/help` lists every command.

## 3. Run one task and exit

```sh
garuda -p "Run the tests and tell me the result"
garuda -p "Fix the lint errors" --output-format json
```

The JSON output has the fields of Claude Code's headless mode, so the same scripts work.

## 4. Set your rules

Put rules in `.garuda/settings.json` in the project. Deny rules always win:

```json
{
  "permissions": {
    "allow": ["bash(pnpm test*)", "edit_file(src/**)"],
    "deny": ["bash(git push*)"]
  }
}
```

Next: the [security model](/garuda/docs/security/), then the [user guide](/garuda/docs/guide/).
