---
title: Editors
description: Use Garuda in VS Code, Zed and other editors over the Agent Client Protocol.
---

`garuda acp` runs Garuda as an agent for editors that speak the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). The editor starts Garuda and shows
the conversation, the tool calls and the questions. Garuda does the work with the same permission
engine, OS sandbox, team policy, hooks and audit log as in the terminal.

Available from version 0.15. Sign-in from the editor (`garuda setup`): version 0.16.

## First: the model and the key

Run this once in a terminal:

```sh
garuda setup
```

It asks for the provider, the model and the key (the input is hidden), checks the key with one free
request, and stores the model in `~/.garuda/models.json` and the key in `~/.garuda/credentials`.
Only you can read that file, and commands in Garuda's sandbox cannot read it. Then the editor needs
no API key in its settings.

Zed (and other editors that support ACP's Terminal Auth) can also run the setup for you: see
[Zed](#zed). Environment variables still work and win over the stored values: `GARUDA_MODEL`,
`ANTHROPIC_API_KEY` and the other providers' key variables.

## VS Code

VS Code has no ACP client of its own. The extension **ACP Client** (publisher `formulahendry`) adds
one.

1. Install the extension: open Extensions, search for "ACP Client", and check the publisher.
2. Find the full path of `garuda` in a terminal: `which garuda`. VS Code started from the Dock does
   not get your shell's `PATH`, so use the full path.
3. Open your user settings: Cmd+Shift+P (Ctrl+Shift+P on Linux), **Preferences: Open User Settings
   (JSON)**. Add:

   ```json
   "acp.agents": {
     "Garuda": {
       "command": "/opt/homebrew/bin/garuda",
       "args": ["acp"]
     }
   }
   ```

4. Open a project folder, open the ACP Client panel, and pick **Garuda**.

Keep the extension's auto-approve off. It answers Garuda's questions for you: the sandbox and the
team policy still apply, but you no longer see the question for an edit or for a command outside
the sandbox.

### Keys in the environment instead

Without `garuda setup`, give the model and the key in the agent's `"env"`:
`{ "GARUDA_MODEL": "claude-sonnet-5", "ANTHROPIC_API_KEY": "..." }`. If you use Settings Sync,
`settings.json` then goes to your sync account with the key in it, so `garuda setup` is the better
choice.

## Zed

In Zed's `settings.json`:

```json
{
  "agent_servers": {
    "Garuda": {
      "type": "custom",
      "command": "/opt/homebrew/bin/garuda",
      "args": ["acp"]
    }
  }
}
```

**Sign-in from Zed** (0.16): when Garuda has no model or no key, a new thread fails with
"Authentication required", and Zed offers **Set up Garuda**. Zed then runs `garuda acp setup` in a
terminal: answer the questions there. The next thread works; Zed need not restart Garuda. (Zed
declares ACP's Terminal Auth; tested with Zed 1.22.)

Other ACP editors (JetBrains IDEs, Neovim with CodeCompanion, Emacs with agent-shell) take the same
two things: the command and the argument `acp`. Editors that support Terminal Auth offer the same
sign-in; in the others, run `garuda setup` in a terminal first.

## What you see

- **Tool calls** show as one line each: `Read README.md`, `Edit README.md`, `$ npm test`. A command
  that exits with an error still shows as done: the error is a normal result, and the model reads
  it. A call that Garuda or you refused shows as failed.
- **Questions** come for each edit (with the editor's diff view) and for each command outside the
  sandbox. The choices are "Allow once", "Allow for this session" and "Deny". "Allow for this
  session" lasts until the editor closes the session. Hidden or control characters in a command are
  shown as ␍, ␛ or [U+…], with a warning line.
- **Stop** (the editor's stop button) ends the turn: a running command stops, and a waiting question
  counts as "Deny". Each tool call that the stop ended shows as failed, with a line such as
  "Garuda: $ sleep 60 cancelled."
- **Modes**: Build and Plan, in the editor's mode menu. In Plan, Garuda reads and plans; it makes no
  edits and asks no questions.
- **Commands**: your custom commands and skills are in the editor's `/` menu. The terminal's own
  commands (`/undo`, `/diff`, `/compact` …) are not available in editors yet.
- **Notices** from Garuda (for example "no OS sandbox") appear as message lines that start with
  "Garuda:".

## What stays in Garuda

- Garuda reads and writes files and runs commands itself, in its own sandbox. It does not use the
  editor's file or terminal access, so it reads the saved file, not an unsaved buffer. Save before
  you ask.
- MCP servers that the editor sends are not started. Garuda's own `~/.garuda/mcp.json` and the
  project's servers work as in the terminal, with their consents.
- Project settings that loosen safety (`.garuda/settings.json`) apply only after you approved them
  in a terminal: run `garuda` once in that folder.

## When it does not start

The editor shows Garuda's messages from stderr in its log (VS Code: View → Output, then the ACP
Client channel; Zed: `dev: open acp logs`). A missing model or key is the error of the new session:
"Authentication required: Garuda has no model." or "… has no key for <model> (<NAME>)". Run
`garuda setup` in a terminal (or use the editor's sign-in), then start a new session.
`garuda setup --show` shows the model and where each key comes from.

On native Windows, Garuda does not run: use WSL (Windows Subsystem for Linux).

The design is in [Editors over ACP](/garuda/docs/design/lld/acp/).
