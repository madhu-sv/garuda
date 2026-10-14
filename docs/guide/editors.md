# Editors

Garuda in Zed, JetBrains, Neovim, Emacs and VS Code over the Agent Client Protocol.

## Editors (ACP, 0.15; sign-in 0.16)

`garuda acp` runs Garuda as an agent for editors that speak the Agent Client Protocol. The editor
starts it, shows the conversation, the tool calls and the questions, and Garuda does the work with
the same permission engine, OS sandbox, team policy, hooks and audit log as in the terminal.

Run `garuda setup` once in a terminal (see Use): then the editor needs no key in its settings.

VS Code, with the extension "ACP Client" (`formulahendry.acp-client`), in the user settings
(Cmd+Shift+P, **Preferences: Open User Settings (JSON)**). Use the full path from `which garuda`:
VS Code started from the Dock does not get your shell's `PATH`.

```json
{
  "acp.agents": {
    "Garuda": { "command": "/opt/homebrew/bin/garuda", "args": ["acp"] }
  }
}
```

Zed: the same command and argument under `agent_servers` (with `"type": "custom"`). With no model
or key, Zed offers **Set up Garuda** (ACP Terminal Auth, 0.16): it runs `garuda acp setup` in a
terminal, and the next thread works. The website's
[Editors](https://madhu-sv.github.io/garuda/docs/editors/) page has the steps and what the editor
shows.

- Each edit asks in the editor, with the editor's diff view; "Allow for this session" lasts for this
  session only. Keep an extension's auto-approve off: it answers Garuda's questions for you.
- The editor's stop button ends the turn: a running command stops, and a waiting question is a deny.
  Each call that the stop ended shows as failed, with a line such as "Garuda: $ sleep 60 cancelled."
  A command that exits with an error shows as done (the model reads the error); a refused call shows
  as failed.
- Build and plan modes are in the editor's mode menu; custom commands and skills are in its `/` menu.
  Built-in chat commands (`/undo`, `/diff` ...) are only in the terminal in this version.
- Garuda reads and writes files and runs commands itself; it does not use the editor's file or
  terminal access, so it reads the saved file, not an unsaved buffer. It does not start MCP servers
  that the editor sends (its own `~/.garuda/mcp.json` and the project's work as usual).
- Project settings that loosen safety apply only after a yes in a terminal (`garuda` in that folder).

Design: [docs/lld/acp.md](../lld/acp.md).
