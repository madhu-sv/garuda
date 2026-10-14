# Chat, sessions and undo

The chat's keys and commands, sessions, limits, context, plan mode, undo, the todo list.

## Chat mode

`garuda` with no task starts a chat. Each line is one task; the conversation carries over.

- `/help`, `/usage` (tokens and cost), `/session` (id and file), `/new` (new session), `/commands`
  (your custom commands), `/plan` and `/build` (plan mode), `/undo` and `/redo`, `/lsp` (language servers),
  `/init` (set up this folder, see [Init](projects.md#init-set-up-a-folder)), `/editor`, `/compact`, `/details`, `/thinking`, `/diff` (see Undo), `/schedule` and `/jobs` (see
  [Scheduled jobs](jobs.md)), `/exit`. Your custom commands and
  skills run with `/name`.
- `/sessions` lists this project's sessions (newest first: time, first prompt, turns, cost, model).
  `/sessions <number or id>` continues one in the chat, as `--resume` does. Read tracking starts again.
  `/sessions rename <number or id> <title>` gives a session a title for the list. `/sessions delete <number
  or id>` asks, then deletes the session file and its subagent logs for good; the open session cannot go.
- `/models` lists the Claude models of your account (saved by `garuda setup`), Garuda's known Claude models
  and the models in `~/.garuda/models.json`, with context window and price ("price unknown" for a model
  that this Garuda version does not know yet). `/models <number, id or opus|sonnet|haiku|fable>` switches the main model for the next turns of this
  chat. The session records the change; a new chat starts with `-m` or `GARUDA_MODEL` again. The prompt cache
  starts again; a smaller window makes Garuda compact the conversation first. Explore keeps the start model.
- `/export [file]` writes the conversation as Markdown in the working folder (default
  `garuda-<session id>.md`): prompts and answers in full, one line per tool call. It comes from the session
  file, so secrets are redacted. It never overwrites a file and never writes outside the folder.
- `/compact [what to keep]` summarises the older turns now, to free context before a new part of the
  work. The last 4 steps stay in full. The optional text tells the summary what to keep, for example
  `/compact keep the API decisions`. Esc stops it; the conversation then stays as it was. Garuda still
  compacts on its own when the context gets full.
- `/details` hides the result line under each tool call (`⎿ 12 line(s)`), so a turn shows one line per
  call. A failed call still shows its result, and Ctrl-O still shows the last output in full. `/details`
  again, or `/details on`, shows them. It applies to new lines only.
- `/thinking` controls Claude's thinking for this chat. Claude Opus 5.5, Opus 5 and Sonnet 5 always think;
  Opus 4.6 to 4.8 and Sonnet 4.6 think only after `/thinking on`. `/thinking low|medium|high|xhigh|max`
  sets the effort (less or more thinking; `default` goes back). Garuda always asks for short summaries
  of the thinking, so data keeps coming while the model thinks (with no data for 5 minutes, the
  connection closed and a long answer was lost; Garuda now also waits up to 20 minutes for the next
  data). By default they are hidden. `/thinking show` shows
  them: the chat shows their first lines dimmed, and Ctrl-O shows all of it until the next tool output
  replaces it; `hide` goes back. The session records the choice; `"thinking": { "effort": "low",
  "show": true }` in settings sets the start value. A change of effort or on/off starts the prompt cache
  again; show and hide do not. Other providers do not offer it.
- Esc or Ctrl-C during a task stops the task and kills its commands (Esc also drops queued lines). The
  chat goes on, and the model learns with your next message that you stopped the task, so it does not
  go on with it unless you ask. A second Ctrl-C during the task exits Garuda at once; Esc never exits.
- New lines: end the line with `\` and press Enter, or press Alt+Enter (Option+Enter on a Mac with
  "Use Option as Meta"). Pasted text keeps its new lines and is never sent by itself.
- `@path` attaches a file or folder: `fix the bug in @src/cart.ts`. The file's text goes with your
  message (numbered, up to 2,000 lines) and counts as read, so the model can edit it at once; a folder gives
  its list of entries. The same rules as `read_file`: only files in the folder, no secrets (`.env`, keys),
  and the same permission check (deny rules, the team policy's `denyPaths`, a link to a secret; 0.14).
  Garuda shows what it attached. A word after `@` that is not a path stays text.
- `!command` runs a command yourself, like the bash tool: in the sandbox with no question, deny rules and
  hooks apply. You see the output, and it goes to the model with your next message. Esc stops it.
- Tab completes `/commands` (built-in, your own, skills) and `@paths`; with several matches it lists them.
  It also completes arguments: `/models <model>`, `/sessions <id|rename|delete>` (with each session's
  title), `/jobs <id|cancel>`, `/diff last`, `/mcp logout <server>` and `/lsp install <language>`.
- When no path starts with what you typed after `@`, Tab searches all files by their letters in order:
  `@rntm` finds `src/app/runtime.ts`. One match completes; otherwise the best 10 are listed. The search
  skips hidden files, `node_modules`, `dist`, `build`, `target` and virtual environments.
- Ctrl-P opens the command palette (full chat only): every command with its one-line help, then your
  own commands and skills. Type to filter: `thk` finds `/thinking`; when no name matches, words of the
  help do (`markdown` finds `/export`). ↑/↓ choose. Enter runs a command that needs no arguments (`/usage`, `/undo`, `/details` …) or puts
  `/name ` in the input line for one that takes them (`/models`, `/sessions`, `/thinking` …), so Tab can
  complete the rest. Esc or Ctrl-P closes it.
- Ctrl-G (or `/editor`) opens the prompt in `$VISUAL` or `$EDITOR` (default `vi`). The saved text comes
  back into the input line; press Enter to send it. The plain chat also joins lines that end with `\`.
- At the prompt, Ctrl-C clears the line; Ctrl-C twice (within 2 s) or Ctrl-D exits.
- On a terminal, the chat uses Ink (0.2): model text streams, and each finished paragraph gets
  basic markdown styles. A spinner shows running tools. The footer shows the model, the sandbox,
  the context use and the cost.
- Type-ahead: type during a task and press Enter to queue the next task.
  Keys typed before the chat is ready are kept too.
- Ctrl-O prints the full output of the last tool call. ↑ and ↓ browse earlier inputs.
- Approvals show the full diff or command in the scrollback. Answer with ↑↓ and Enter, or
  y (once), a (session), n or Esc (deny). For `edit_file`, press `h` (or `p`) to review hunks one by one (0.14): only the hunks you stage
  are written, and the model is told which ones you rejected. A diff too long to show in full has no `h`.
- `GARUDA_PLAIN=1` turns Ink off. Pipes, `-p`, the evals and the standalone binary always use plain output.
- Notifications: when an approval waits during a task, and when a task that ran 10 s or longer ends, Garuda
  tells you. In iTerm2, Ghostty and WezTerm it sends a desktop notification (the OSC 9 escape code); in other
  terminals and in tmux it rings the bell. `GARUDA_NOTIFY=off|bell|osc9|auto`, or
  `"notifications": { "channel": "off", "afterSeconds": 30 }` in `.garuda/settings.json`, changes it.
  In iTerm2 the notification needs "Send escape sequence-generated alerts" (Settings › Profiles › Terminal),
  which is on by default.
  In iTerm2, Ghostty, WezTerm and the VS Code terminal, the full chat turns on focus reporting: while
  Garuda's window has focus, no notification goes out. In other terminals, in tmux and in the plain chat,
  every notification goes.
- Files are written atomically (a temporary file, then a rename), so an exit never leaves half a file.
- `garuda --resume` continues the latest session in chat mode.

Model text goes to stdout; tool activity and notes go to stderr. So `garuda -p "…" > answer.md` keeps only the answer.

## Sessions, limits and context

Every run writes a session file: `.garuda/sessions/<id>.jsonl` (one JSON record per line, mode 0600).
It holds every message, tool call, result, token count and cost. Garuda redacts known secret
formats (API keys, tokens, private keys, `password=…`) and the values of secret-looking environment
variables before it writes a line. The model can still see a secret; the file never holds it.

```sh
garuda -p "Find the flaky test"                 # new session
garuda --resume -p "Now fix it"                 # continue the latest session
garuda --resume 20260923-201500-a1b2 -p "…"     # continue a given session
garuda --replay 20260923-201500-a1b2            # replay it: no API calls, no tools run
```

- After each turn Garuda prints steps, tokens (with cache reads), cost, context use and the session total.
- A run stops at 50 steps, at the session token budget (20M tokens), or after the same tool call
  3 times in a row. Garuda says why. The budget holds for the whole turn (0.17): each model call
  reserves its request and its output limit first, and stops when they do not fit; subagents,
  compaction and retries reserve in the same budget, and a subagent never takes the room that the
  parent needs for its final answer. Every generation attempt reserves, also provider retries
  and a batch job's switch to the normal API. Any call without complete provider-reported usage
  keeps its full reservation charged, even if the response succeeded, also after a resume.
  Reported child expenditure is saved immediately,
  including before cancellation or a parallel batch failure. `/compact` counts its full summary
  request too. Complete tool results, including errors and hook feedback, are at most 100 000
  characters; subagent results are at most 20 000 including metadata. The final-answer floor
  allows for worst-case JSON escaping, so small budgets can refuse child work earlier.
  Every request estimate covers the full current system prompt, conversation, tool definitions
  and provider settings, including after a resume or model change. If the previous measured context
  plus new messages is larger, Garuda keeps that allowance. This can refuse a call earlier.
  Missing, partial or invalid OpenAI-compatible usage gets a labelled estimate for context sizing.
  Estimates are excluded from reported token totals and never added on top of the full charge.
  `/usage` and the turn summary show the separate budget charge; the cost shows as a minimum,
  "≥ $X (incomplete)", never as unknown. Providers that
  omit usage can therefore reach the budget sooner. JSON marks estimated assistant usage and
  incomplete result totals; eval reports show unknown tokens, means and cache share for these runs.
- When the connection to the model breaks while a response streams, Garuda sends the request again (up
  to 2 times) and says so. The session keeps only the complete response.
- At 80% of the context window, Garuda first cuts long tool outputs in older turns. If that is not enough,
  the model summarises the older turns. The last 4 turns always stay in full.
- `AGENTS.md`, `CLAUDE.md` and `GARUDA.md` in the project root go into the system prompt, in that order;
  `GARUDA.md` wins on a conflict. A file with the same text as an earlier one goes in once.
- Project memory: the `remember` tool saves lasting facts (build and test commands, layout, conventions)
  to `.garuda/memory.md`, with your approval. The next session loads them after `GARUDA.md`.
  Edit or delete lines freely. Add `remember` to `permissions.allow` to skip the question.
- `read_file` does not send the same lines of an unchanged file twice. After compaction it sends them again.
- Garuda knows the price and context window of current Claude models. For other models, set them in settings.

## Plan mode

In plan mode the agent reads the code and writes a plan; it cannot change anything.

- `/plan` and `/build` switch the mode; in the chat, Shift+Tab toggles it. `garuda --plan` starts in plan
  mode. The footer shows `PLAN`. `/plan <task>` switches and plans the task at once (`/build <task>` too).
- Allowed: reading tools, and bash in the sandbox, which then cannot write the project (temp folders and
  package caches only), so read-only commands and many tests still work. Denied, with no question: file
  edits and writes, `remember`, commands outside the sandbox, and web_fetch or MCP tools without an allow
  rule. With no OS sandbox, bash is off in plan mode.
- When the plan is ready, Garuda asks "Build this plan?": build it now, switch to build mode and type the
  task yourself, or keep planning.

## Undo

Before each turn, Garuda takes a snapshot of the project. `/undo` takes back the last turn: its file
changes (edits, new and deleted files, and files that commands changed) and its messages, so the model
forgets it. `/redo` brings it back.

- It asks first, with the list of files. Changes that you made after the turn go back too.
- Snapshots are in `~/.garuda/snapshots`, in a git store of Garuda's own. Your repository, index and
  branches do not change, and the project does not need git. `.gitignore` rules apply.
- It works after `garuda --resume`. After the conversation was compacted, undo restores only the files.
- Cost: about 15–90 ms per turn. `"undo": { "enabled": false }` in `.garuda/settings.json` turns it off.
- `/diff` shows what changed since the first turn of this session: the files with `+`/`−` line counts, then
  the diff (300 lines; Ctrl-O shows all). `/diff last` shows only the last turn; `/diff <path>` or
  `/diff last <path>` limits it to one file or folder. It compares with the files now, so your own changes
  count too. It uses the undo snapshots, so it is off when undo is off.

## Todo list (opt-in)

`"todo": { "enabled": true }` in `.garuda/settings.json` gives the model a `todo_write` tool: for a task
with 3 or more steps it keeps a plan, and the chat shows it as a checklist (`✔`, `▶`, `○`). It is off by
default: in the A/B eval on the hard suite the model never called it. Measure it again with
`garuda eval -s hard --repeat 3 --todo on`.
