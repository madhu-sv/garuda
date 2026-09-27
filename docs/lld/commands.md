# Custom slash commands (`src/commands/`)

## Purpose

Save a prompt that you use often as a Markdown file and run it with `/name`. Added in 0.4.

| File | Role |
| --- | --- |
| `custom.ts` | Load, parse, expand, and the consent question for project commands. |
| `builtins.ts` | The names of the built-in chat commands; a custom command cannot use them. |

## Files

| Place | Source | Trust |
| --- | --- | --- |
| `~/.garuda/commands/<name>.md` | user | Trusted: runs with no question. |
| `<root>/.garuda/commands/<name>.md` | project | A cloned repository can add them: the first run shows the full text and asks. |

- A file in a subfolder gets a name with `:`: `frontend/test.md` → `/frontend:test`. Names are lower case
  and hold only `a–z`, `0–9`, `-` and `_`.
- Optional frontmatter between two `---` lines: `description` and `argument-hint`, for `/help` and
  `/commands`. A small reader handles `key: value` lines; no YAML library.
- The rest of the file is the prompt. Files over 20 000 characters, and files with no text, are skipped with
  a notice. At most 200 files per folder.

## Expansion

`expandCommand(command, args)`:

- `$ARGUMENTS` → everything after the name.
- `$1` … `$9` → one argument each; quotes group words (`"a b.ts"`); a missing one becomes empty.
- With no placeholder in the text, the arguments go after it as `Arguments: …`.

The result becomes the user's prompt. A command is only text: every tool call that it leads to passes the
permission engine and the sandbox, as for a typed prompt.

## Name clashes

1. A built-in name (`/help`, `/new`, `/exit`, and since 0.6 `/sessions`, `/models`, `/export`, `/diff` …)
   always wins; a file with that name is skipped.
2. A user command wins over a project command with the same name: a repository cannot replace a command
   that you trust.
3. A skill with the same name wins over a command (0.5, as in Claude Code): `resolveCommand` checks skills
   first. See [skills.md](skills.md).

Each skipped file gives a notice at start (`onNotice`).

## Project commands: consent

`Runtime.resolveCommand(line, signal)` returns `none`, `prompt` or `denied`. For a project command it
checks `~/.garuda/trust.json` (`commands[root][name]` holds the SHA-256 of the file):

| Case | Behaviour |
| --- | --- |
| Hash matches | Runs with no question. |
| No hash, or a different hash | Shows the question: title, file, the full text (each line after `│`), and a note that tool calls still ask or run in the sandbox. A changed file says so. |
| "Yes, for this session only" | Runs; no question again in this process. |
| "Yes, and remember" | Runs; the hash goes into `trust.json`. |
| "No" | Does not run: "You did not run /name." |

Hardening of project files, because the text reaches the terminal and the model:

- Symbolic links are refused: a link named `x.md` could show a secret file as a command.
- `cleanText` removes terminal escape codes, control characters, bidi overrides, zero-width and tag
  characters (they could hide lines in the consent preview); descriptions and hints too.
- `neutralizeTags` breaks Garuda's own markers (`<garuda_note>` …), so a command cannot pose as a note from
  Garuda.

## Where commands run

- Plain chat and Ink chat: `runCommand` tries the built-ins first, then `resolveCommand`. A custom command
  returns `{ prompt }`, and the chat runs a turn with it. The Ink chat shows the typed line once; the model
  gets the expanded prompt.
- One task: `garuda -p "/review src/a.ts"` runs the command; a denied project command exits with 1. Other
  text that starts with `/` goes to the model as it is.
- `/commands` lists the custom commands with their hint, description and `(project)`; `/help` adds the same
  list after the built-ins.
- The evals load no commands (`commands: false`).

## Tests

`test/commands.test.ts`: frontmatter, command line, placeholders; loading with subfolders, built-in and
user/project clashes, bad names, empty and large files; symlink refusal and text cleaning; the built-in list
against `/help`; user commands with no question; project consent (deny, this session, remember, changed
file); `/help`, `/commands` and unknown commands; the Ink chat path.
