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
  childDebits: Map<string, number>; // reported child tokens not yet included in a tool report
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
| `closeOpenToolCalls(session)` | an error result for each `tool_use` with no result (after Ctrl-C or a crash); also forgets the read deduplication. `Runtime.runTurn` calls it before the new user message (0.14, review): Ctrl-C at an approval left an open call, and the API refused every later request of the chat | `tool_results` |

## Records (`records.ts`)

One JSON object per line, each with `t` (ISO time) and `type`:

| Type | Fields |
| --- | --- |
| `start`, `resume`, `model` | sessionId, root, version, model, executor, isolation, limits (maxSteps, tokenBudget, contextWindow). `model` (0.6): `/models` switched the model; resume and replay treat it like `resume`. A `model` record, or a start or resume record with another model, drops the thinking blocks before it, as `/models` does live (0.14, review). |
| `user` | message |
| `assistant` | step, response, costUsd? |
| `tool_results` | message, `calls` (per call: toolUseId, name, durationMs, executor and isolation for commands, `subagent` report for explore calls), `synthetic` for closed open calls |
| `compaction` | stage, before and after tokens, the new messages, the summary response and its cost (stage 2) |
| `snapshot` | tree (the undo snapshot of the files before the turn), messages (the count before the turn), prompt (one short line), durationMs (0.4) |
| `undo` | after (the snapshot of the files at the undo) (0.4) |
| `redo` | – (0.4) |
| `title` | title (0.8, `/sessions rename`; the last one wins; resume ignores it) |
| `thinking` | choice (0.9, `/thinking`; the last one wins; a resume brings it back) |
| `continue` | message, maxTokens (0.12: the note after a response cut off at the output limit; a resume adds the message; not a turn in `/sessions`) |
| `unreported` | tokens (0.17, T9: any model request without complete reported usage keeps its whole reservation, also on success; the session's budget counts these with reported usage, and a resume adds them up in `unreportedTokens`) |
| `child_debit` | childSessionId, tokens (reported child spend, written immediately at settlement; a later tool report replaces only the amount it includes, so cancellation and partial reports cannot erase expenditure or double-charge it) |
| `side_usage` | purpose (`review`), usage, costUsd (Codex review of 1370184: a model request outside the conversation, the job review; its usage counts for the session's budget and cost, and resume adds it) |
| `end` | stopReason, steps |

## Store (`store.ts`)

```ts
interface SessionStore {
  open(sessionId): Journal;          // Journal.write(record); an id with other characters than
                                     // letters, digits, "-" and "_" is refused (0.14: --resume ../x)
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
3. Assignments such as `password = "…"`, `api_key: …`: the name stays, the value goes. Code and
   numbers stay (`looksLikeCode`): `tokenBudget: 20000000`, `tokenBudget: z.number()…`,
   `apiKey: options.apiKey`. A number under a password or secret name is still removed (a PIN).
   Before this, reading Garuda's own source changed `tokenBudget` lines on disk, and a resume failed.

The Redactor leaves `encrypted_content` and `encrypted_index` alone (0.6): they are ciphertext from Claude's
web search and must go back unchanged. Since 0.9 it also leaves thinking `signature` values and the `data`
of `redacted_thinking` blocks alone. The readable thinking text is redacted as usual; a block that
changed that way is left out on resume (`repairThinking`), because its signature would no longer match.
The API binds a signature to all content before the block too. So when redaction changed any message
on disk (a tool result with a secret), every thinking block from that message on is left out on resume
(`dropThinkingAfterRedaction`); the blocks before it go back unchanged. Live case: a resume answered
400 "The block is bound to a different conversation".
A resume with another model than the session's last one leaves all thinking out.

## Resume (`resume.ts`)

The session allowance counts reported usage, unreported reservations and pending child debits.
Responses marked `usageReported: false` keep their estimates for context sizing but contribute no
reported tokens or exact USD cost. The full reservation is already in `unreportedTokens`, so live
accounting and replay never add the estimates again. The same rule applies to summary responses.
Any unknown reservation marks the session cost incomplete (`costIncomplete`), including after
replay; `costUsd` stays a known minimum, shown as "≥ $X (incomplete)" (review of 1370184: before,
one failed attempt made the cost unknown for the rest of the session). Only a missing price makes
the cost unknown. A subagent report carries `costIncomplete` to its parent. Existing journals
without the source flag retain their historical totals: their old estimates cannot be distinguished
from reports retroactively. No migration is performed; the corrected policy applies to new calls.
`rebuildState` restores the same pending-debit map. Journals without `child_debit` records keep
their original totals, with an empty map; no on-disk migration is needed. Returned child reports
still provide usage and USD-cost breakdowns. Pending debits protect the token allowance; they do
not invent a USD charge for an interrupted child whose report did not reach the parent.

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
| `forgetReads()` | Compaction, `/undo`, `/redo` and `closeOpenToolCalls` clear the dedup memory, because the earlier output may be gone (the last three since 0.14, review). |

## Tests

`test/sessions.test.ts` (journal, redaction, resume, replay), `test/m4.acceptance.test.ts`,
`test/sessionCommands.test.ts` (0.6: `/sessions`, `/models`, `/export`; 0.8: `/compact`, `/sessions rename` and `delete`).
