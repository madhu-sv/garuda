# Undo (`src/undo/`, `src/session/undo.ts`)

## Purpose

`/undo` takes back the last turn: the files go back to how they were before the turn, and the turn leaves
the conversation, so the model forgets it. `/redo` brings both back. Added in 0.4.

It covers every change in the project, not only `edit_file` and `write_file`: a command in the sandbox
can write files with no approval, and undo takes those changes back too. It works in any folder, with or
without git, and it never touches the project's own `.git`.

| File | Role |
| --- | --- |
| `src/undo/snapshots.ts` | `SnapshotStore`: take a snapshot, list the changes between two, restore one. |
| `src/undo/question.ts` | The question before `/undo` and `/redo`: the turn, the files, the conversation. |
| `src/session/undo.ts` | The conversation side: undo points and the redo stack, as pure steps. |

## Snapshots

A snapshot store is a git folder of Garuda's own: `~/.garuda/snapshots/<first 16 hex of sha256(root)>`
(mode 0700). The project is its work tree; the store has its own index.

| Step | git |
| --- | --- |
| Take | `ls-files --cached --others --exclude-standard` (count), `add -A`, `write-tree` → a tree id |
| Changes | `diff-tree -r -z --no-renames --name-status <from> <to>` |
| Restore | `read-tree -m -u <from> <to>`: new, changed and deleted files; it refuses when a file changed after `<from>` was taken |

- `.gitignore` rules apply, so ignored folders (`node_modules`, build output) are not in snapshots, and
  undo does not change them.
- Never in a snapshot: `.git`, `.garuda/sessions/`, `.garuda/index/`, `.garuda/evals/`. `.garuda/memory.md`
  and the settings are in it.
- git runs through the Executor (N8), outside the sandbox (the store is outside the project), with no
  system or global config (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`), no hooks and no
  fsmonitor. Tree ids are checked before they go into a command.
- Sandbox commands cannot write `~/.garuda`, so they cannot change the undo history.
- `git gc --auto` runs every 20 snapshots: it packs the objects, and git prunes snapshots that no longer
  matter after two weeks (its default). An undo point older than that fails with a clear message.

## Turns

`Runtime.runTurn` takes a snapshot before the user message and records a `snapshot` record: the tree, the
message count before the turn, and the prompt's first line. Plan-mode turns get one too.

| Case | Result |
| --- | --- |
| The snapshot fails (no git, too many files, an error) | Undo is off for this session; one notice; the turn runs. |
| A snapshot takes more than 10 s | Undo is off for this session; one notice (add big folders to `.gitignore`). |
| More than 50 000 files | No snapshot (the first `git add` would be too slow). |

## `/undo` and `/redo`

1. Take a snapshot of the files now.
2. List the changes from now to the target (the last undo point, or for `/redo` the state at the undo).
3. Ask, with a yes/no question: the turn, the files (`+` comes back, `-` is removed, `~` changes, at most
   30 lines), and what happens to the conversation. Changes that the user made after the turn go back too,
   so it always asks.
4. Restore the files (`read-tree`, which refuses when a file changed during the question), then change
   the conversation and write an `undo` or `redo` record.

Conversation rules (`src/session/undo.ts`):

- An undo point holds the message count before its turn. `/undo` cuts the messages there; the cut part
  goes to the redo stack. `/redo` puts it back.
- A new user message ends the redo chain.
- After a compaction, the earlier turns are no longer separate messages: undo then restores only the
  files, and the next turn gets a `<garuda_note>` that the user undid the turn.
- At most 50 undo points per session.
- The records are in the session file, so `/undo` works after `garuda --resume`; replay applies them too.

## Turn it on or off

On by default in the CLI (chat and `-p`, so a later chat can undo a `-p` task). `"undo": { "enabled": false }`
in `.garuda/settings.json` turns it off. The `Runtime` option `undo` enables it; tests and evals leave it out.

## Cost (0.4, measured in the cloud workspace)

| Project | First snapshot | Next snapshot, no change | One changed file | Store |
| --- | --- | --- | --- | --- |
| Garuda repository (~230 files) | 137 ms | 15 ms | 17 ms | 1.7 MB |
| 20 000 small files | 1.3 s | 66 ms | 88 ms | 84 MB (before packing) |

## Tests

`test/undo.test.ts`: take, changes and restore (added, changed, deleted files); `.gitignore`, Garuda's
records and the project's own git untouched; a file that changed after the snapshot; too many files and bad
ids; the store folder and its mode; the conversation steps and their records (undo, redo, a new prompt, a
compaction); `/undo` and `/redo` through `Runtime` with an edit and a command; "No"; undo after
`--resume`; a missing snapshot; the chat commands; off by default in `Runtime` and with the setting; a
failing snapshot; replay with an undo; the question text.
