# Sessions (`src/session/`)

## Purpose

Keep the conversation in memory, write every change to a journal on disk (F24), continue a session
(F25), feed replay (F26), and never write a secret to disk (N6).

## Session (`session.ts`)

```ts
interface Session {
  id; root;
  messages: Message[];
  usage: Usage; costUsd?: number; contextTokens: number;
  files: FileTracker;
  journal?: Journal;
}
```

Every change goes through these functions, so the journal always matches memory:

| Function | Change | Record |
| --- | --- | --- |
| `addUserMessage(session, text, notes, attachments)` | user message: the prompt, then one `<garuda_note>` text block per note, then one plain text block per attachment (`@path`, 0.6) | `user` |
| `addAssistantResponse(session, response, step, cost)` | assistant content, usage, cost, context size | `assistant` |
| `addToolResults(session, results, meta)` | one user message with the tool results | `tool_results` |
| `closeOpenToolCalls(session)` | an error result for each `tool_use` with no result (after Ctrl-C or a crash) | `tool_results` |

## Records (`records.ts`)

One JSON object per line, each with `t` (ISO time) and `type`:

| Type | Fields |
| --- | --- |
| `start`, `resume`, `model` | sessionId, root, version, model, executor, isolation, limits (maxSteps, tokenBudget, contextWindow). `model` (0.6): `/models` switched the model; resume and replay treat it like `resume`. |
| `user` | message |
| `assistant` | step, response, costUsd? |
| `tool_results` | message, `calls` (per call: toolUseId, name, durationMs, executor and isolation for commands, `subagent` report for explore calls), `synthetic` for closed open calls |
| `compaction` | stage, before and after tokens, the new messages, the summary response and its cost (stage 2) |
| `snapshot` | tree (the undo snapshot of the files before the turn), messages (the count before the turn), prompt (one short line), durationMs (0.4) |
| `undo` | after (the snapshot of the files at the undo) (0.4) |
| `redo` | – (0.4) |
| `title` | title (0.8, `/sessions rename`; the last one wins; resume ignores it) |
| `thinking` | choice (0.9, `/thinking`; the last one wins; a resume brings it back) |
| `end` | stopReason, steps |

## Store (`store.ts`)

```ts
interface SessionStore {
  open(sessionId): Journal;          // Journal.write(record)
  openChild(sessionId, childId): Journal;   // a subagent run, kept with its parent (0.3)
  read(sessionId): Promise<SessionRecord[]>;
  latest(): Promise<string | undefined>;
  list(): Promise<{ id; updated: Date }[]>;   // newest first (0.6, /sessions)
  setTitle(id, title): Promise<void>;          // 0.8: appends a title record, keeps the file time
  remove(id): Promise<void>;                   // 0.8: the file and its subagent folder
}
```

`FileSessionStore`: `.garuda/sessions/<id>.jsonl`; subagent runs in `.garuda/sessions/<id>/<child id>.jsonl`
(`explore-<call id>` for explore, `agent-<name>-<call id>` for custom agents, 0.5)
(ids cleaned to `[A-Za-z0-9_-]`; `latest()` ignores the subfolders, so `--resume` never picks a child). The folder is 0700 and files are 0600. Each record is
one `appendFileSync`, so a crash loses at most the line in progress. Every string passes the
`Redactor` first. Ids: `YYYYMMDD-HHMMSS-xxxx`. `MemoryJournal` serves tests. A shared store (for example
Redis) can implement the same interface later.

`list.ts` (0.6): `summariseSession(id, updated, records)` gives one `/sessions` row: the first line of the
first prompt (60 characters), the number of prompts, the model of the last `start`/`resume`/`model` record,
and the cost from `rebuildState`.

## Redaction (`redact.ts`)

The model may see a secret, but Garuda never writes it to disk. The `Redactor` replaces with
`[REDACTED]`:

1. Values of environment variables whose names contain KEY, TOKEN, SECRET, PASSWORD, PASSWD or
   CREDENTIAL (8 characters or longer), wherever they appear.
2. Known formats: private key blocks, Anthropic and OpenAI keys, AWS access key ids, GitHub tokens, Slack
   tokens, Google API keys, JWTs.
3. Assignments such as `password = "…"`, `api_key: …`: the name stays, the value goes.

The Redactor leaves `encrypted_content` and `encrypted_index` alone (0.6): they are ciphertext from Claude's
web search and must go back unchanged. Since 0.9 it also leaves thinking `signature` values and the `data`
of `redacted_thinking` blocks alone. The readable thinking text is redacted as usual; a block that
changed that way is left out on resume (`repairThinking`), because its signature would no longer match.
A resume with another model than the session's last one leaves all thinking out.

## Resume (`resume.ts`)

`rebuildState(records)` replays the records into messages, usage, cost and context size (compaction
records replace the messages; subagent reports in `tool_results` add their usage and cost; `snapshot`,
`undo` and `redo` records rebuild the undo state and take turns out of the messages or put them back, with
the same steps as live, from `undo.ts`). `resumeSession` loads the latest or a given session, writes a `resume`
record, and continues in the same file. The read tracking starts empty: the agent must read a file again
before it edits it.

## Read tracking (`fileTracker.ts`)

| Method | Use |
| --- | --- |
| `record(path, content)` | `read_file` and `write_file` note the content the agent knows. |
| `status(path, content)` | `edit_file`: `unread`, `changed` or `current`. Only `current` may be edited (F11). |
| `noteRead(path, content, offset, limit)` | Read deduplication: true when the same range of the same content was read before. |
| `forgetReads()` | Compaction clears the dedup memory, because the earlier output may be gone. |

## Tests

`test/sessions.test.ts` (journal, redaction, resume, replay), `test/m4.acceptance.test.ts`,
`test/sessionCommands.test.ts` (0.6: `/sessions`, `/models`, `/export`; 0.8: `/compact`, `/sessions rename` and `delete`).
