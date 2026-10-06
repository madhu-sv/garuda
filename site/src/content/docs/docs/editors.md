---
title: Editors
description: Use Garuda in VS Code, Zed and other editors over the Agent Client Protocol.
---

`garuda acp` runs Garuda as an agent for editors that speak the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). The editor starts Garuda and shows
the conversation, the tool calls and the questions. Garuda does the work with the same permission
engine, OS sandbox, team policy, hooks and audit log as in the terminal.

Available from version 0.15.

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
       "args": ["acp"],
       "env": { "GARUDA_MODEL": "claude-sonnet-5", "ANTHROPIC_API_KEY": "..." }
     }
   }
   ```

4. Open a project folder, open the ACP Client panel, and pick **Garuda**.

Keep the extension's auto-approve off. It answers Garuda's questions for you: the sandbox and the
team policy still apply, but you no longer see the question for an edit or for a command outside
the sandbox.

### Keep the API key out of settings.json

If you use Settings Sync, `settings.json` goes to your sync account. A small script keeps the key on
your machine:

```sh
mkdir -p ~/bin && cat > ~/bin/garuda-acp <<'EOF'
#!/bin/zsh
source ~/.zshrc >/dev/null 2>&1   # loads ANTHROPIC_API_KEY and PATH
export GARUDA_MODEL=claude-sonnet-5
exec garuda acp
EOF
chmod +x ~/bin/garuda-acp
```

Then set `"command"` to the full path of `~/bin/garuda-acp`, `"args"` to `[]`, and leave out
`"env"`.

## Zed

In Zed's `settings.json`:

```json
{
  "agent_servers": {
    "Garuda": {
      "type": "custom",
      "command": "/opt/homebrew/bin/garuda",
      "args": ["acp"],
      "env": { "GARUDA_MODEL": "claude-sonnet-5", "ANTHROPIC_API_KEY": "..." }
    }
  }
}
```

Other ACP editors (JetBrains IDEs, Neovim with CodeCompanion, Emacs with agent-shell) take the same
three things: the command, the argument `acp`, and the environment.

## What you see

- **Tool calls** show as one line each: `Read README.md`, `Edit README.md`, `$ npm test`. A command
  that exits with an error still shows as done: the error is a normal result, and the model reads
  it. A call that Garuda or you refused shows as failed.
- **Questions** come for each edit (with the editor's diff view) and for each command outside the
  sandbox. The choices are "Allow once", "Allow for this session" and "Deny". "Allow for this
  session" lasts until the editor closes the session. Hidden or control characters in a command are
  shown as ␍, ␛ or [U+…], with a warning line.
- **Stop** (the editor's stop button) ends the turn: a running command stops, and a waiting question
  counts as "Deny".
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
Client channel). A missing model or key is the error of the new session, for example "Set a model
with --model <id> or the GARUDA_MODEL variable."

The design is in [Editors over ACP](/garuda/docs/design/lld/acp/).
