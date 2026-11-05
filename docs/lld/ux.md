# UX: show the trust and the evidence (design)

Status: design approved (2026-11-05: the user took every suggested default, D1–D10). Built: patch 1
(U1, U3, U10), patch 2 (U2), patch 3 (U4) and patch 4 (U6); see "As built" at the end.

## Purpose

Garuda does more than it shows. It has an OS sandbox, a network proxy, undo snapshots, hunk
staging, proof of work for jobs, and evals with intervals. During a turn the chat shows a spinner,
one line per tool call and a footer. A user learns about the sandbox, undo and the night shift
only from the docs.

This design makes those parts visible in the chat. A user should see, after each turn:

- what changed, and how to take it back;
- what ran, and where it ran (in the sandbox or outside it);
- what it cost, in the unit that the evals use.

When something stops, the screen gives the next step as one key.

## Rules for every view

- **Data first, then paint.** Each view is a pure function: facts in, lines out. The Ink chat paints
  the lines. The plain chat (`GARUDA_PLAIN=1`), `-p` and pipes print the same facts as plain text.
  Tests need no terminal.
- **Color is never the only signal.** Each state also has a word or a mark (`✓`, `✗`, `⛨`).
  `NO_COLOR` keeps all the facts.
- **80 columns.** Every mock-up below fits 80 columns. Under 60 columns, boxes become plain lines.
  Widths are measured in terminal cells, not characters: some marks (`⛨`, `◐`) take two cells in
  some fonts, so a box pads by cells.
- **No new data on the wire.** A view uses records that Garuda already writes, or adds a session
  record. It never sends more to the model.
- **Quiet by default.** A turn that only answers a question keeps today's one usage line. The
  bigger views appear only when they have something to say.
- **Editors (ACP).** An editor draws its own UI. Garuda sends the receipt as a final text block,
  and nothing else changes there.

## Overview

| ID | Feature | Size | Main code |
| --- | --- | --- | --- |
| U1 | Turn receipt | M | `cli/chat/store.ts`, `cli/report.ts`, `undo/snapshots.ts` |
| U2 | A blocked host as a one-key fix | M | `net/proxy.ts`, `app/runtime.ts`, `permissions/engine.ts` |
| U3 | Each stop gives the next step | S | `cli/report.ts`, `cli/chat/controller.ts` |
| U4 | Live plan, grouped tool lines | M | `cli/chat/store.ts`, `cli/chat/ui.tsx` |
| U5 | Better diffs | M | `cli/chat/hunkStaging.ts`, a new `cli/chat/diffView.ts` |
| U6 | Rewind timeline and fork | M | `session/undo.ts`, `app/undoCoordinator.ts`, `app/sessionManager.ts` |
| U7 | Morning brief | S | `jobs/night.ts`, `cli/repl.ts` |
| U8 | `garuda advise` | L | `cli/evalCommand.ts`, `evals/compare.ts` |
| U9 | First-run tour | S | `cli/setupCommand.ts`, `init/` |
| U10 | Quiet footer and context bar | S | `cli/chat/ui.tsx` |
| U11 | HTML export | M | `cli/export.ts` |
| U12 | Reduced motion and screen-reader mode | S | `cli/chat/ui.tsx`, `cli/banner.ts` |

## U1: turn receipt

After a turn that changed files, ran tests, ran a command outside the sandbox, or had a host blocked:

```
╭─ Turn 4 · done · 7 steps · 38 s ─────────────────────────── $0.0041 ─╮
│ Files    src/cart.ts +12 −4 · src/price.ts +3 −1 · 1 more            │
│ Tests    pnpm test ✓ passed (124 tests, was 121)                     │
│ Sandbox  ⛨ 6 commands in the sandbox · 0 outside · 1 host blocked    │
│ Undo     /undo puts back 3 files                                     │
╰─ context 34% · session $0.0172 · 4 kept changes · $0.0043 each ──────╯
```

A turn that failed its tests:

```
╭─ Turn 5 · done · 9 steps · 51 s ─────────────────────────── $0.0062 ─╮
│ Files    src/refund.ts +8 −2                                         │
│ Tests    pnpm test ✗ failed (2 of 126) · Ctrl-O shows the output     │
│ Sandbox  ⛨ 4 commands in the sandbox · 0 outside                     │
│ Undo     /undo puts back 1 file                                      │
╰─ context 41% · session $0.0234 · 4 kept changes · $0.0059 each ──────╯
```

A turn that only answered keeps today's line:

```
done · 2 step(s) · 9k in (6k cached) / 420 out · $0.0009 · context 5% of 200k
```

**Where the facts come from:**

- **Files.** Today the snapshot before a turn is the undo point. U1 adds one snapshot at the end
  of the turn (`git add -A` and `write-tree`, as for `/undo`). `diff-tree --numstat` between the
  two gives each file's lines, as `/diff` does now. When undo is off, the Files row says "undo is
  off: no file list".
- **Tests.** A bash call whose command contains the project's test command (`detectTestCommand`
  from `jobs/proof.ts`) counts as a test run. Its exit code gives ✓ or ✗. The count ("124 tests")
  comes from the summary line of known runners: vitest, jest, node:test, pytest, Maven Surefire,
  `go test`. An unknown runner shows only ✓ or ✗. "Was 121" comes from the last receipt that had a
  count. The row is absent when no test ran.
- **Sandbox.** The bash calls of the turn, split by where they ran, and the hosts that the proxy
  blocked (`takeBlocked`). "0 outside" stays on the line on purpose: it is the claim that matters.
- **Undo.** The file count of the turn's undo point.
- **The bottom line.** A **kept change** is a turn that changed files and was not undone. Session
  cost divided by kept changes gives the eval unit in daily use. The line shows it after the first
  kept change.

**Records.** A new session record `receipt` holds the facts, so `--resume`, `--replay` and
`/export` show the same receipt. Old sessions have no such record and show today's line.

**JSON (`-p --json`).** The result gets a `receipt` object with the same fields.

## U2: a blocked host as a one-key fix

**Today.** With no allowlist, the sandbox has no network and no proxy. `npm install` fails with
`ENOTFOUND` or `EAI_AGAIN`. The model may retry, or ask to run the command outside the sandbox. With an allowlist, an unknown host already asks the user.

**Design.** When a project has no allowlist, Garuda starts the proxy in **watch mode**. It allows
no host, but it records each host that a command asks for. After the command:

```
⛨ The sandbox blocked registry.npmjs.org (from: pnpm install).
  The command failed because it had no network.
  ❯ 1. Allow the npm preset for this session
    2. Allow it for this project (writes network.allow in .garuda/settings.json)
    3. Keep it blocked
  ↑↓ and Enter, or 1 2 3 · y = 1 · p = 2 · n or Esc = 3
```

- A known registry host maps to its preset (`npm`, `pypi`, `maven`, `go`, `cargo`, `github`). Any
  other host is named as it is.
- The choice gives the model a note, as the allowlist does today: "registry.npmjs.org works in the
  sandbox now. Run the command again in the sandbox." So the model stops asking to leave the sandbox.
- Plan mode, jobs, evals and the strict profile do not ask. They keep today's deny, and the
  receipt names the host.
- The team policy wins: a host in `blockedHosts` never gets the question, only a note.
- On Linux, watch mode needs `node` on the PATH for the bridge into bubblewrap, as the allowlist
  does. Without it, watch mode is off and the receipt says "network off".

**Cost.** Today the proxy (`node:http`) loads only for a project that has an allowlist (N3). Watch
mode loads it in every chat with a sandbox. See decision D3.

## U3: each stop gives the next step

Today's messages say what happened and then name a settings key. In the chat, the next step
becomes one key:

```
■ Stopped at the step limit (50). The task is not finished.
  [Enter] go on for 50 more steps · [s] summarise what is left · [Esc] stop here
```

```
■ Stopped: the same tool call 3 times in a row (read_file src/cart.ts).
  The agent may be stuck. Type a hint and press Enter, or Esc to stop here.
```

A stop at the session token budget keeps today's text, which names `limits.tokenBudget`. Compaction
frees context, not budget, so the chat offers no key for it.

`-p` and pipes keep today's text, which names `--resume`.

## U4: live plan and grouped tool lines

Today each tool call is one line, and a long turn fills the screen with `read_file` lines. U4
groups calls of one kind that come one after another, and shows the todo list as a live checklist
when the model has one:

```
  Plan
  ✓ Find where the price is cached
  ◐ Add the currency to the cache key
  ○ Run the tests

  ✓ Read 4 files              src/cart.ts, src/price.ts, src/cache.ts, +1
  ✓ Searched 2 times          "priceCache", "getPrice("
  ⠹ Editing src/cache.ts
```

- A group closes when another kind of call starts. The scrollback keeps one line per group.
  Ctrl-O shows the last call's output in full, as today. `/details` shows one line per call again.
- The plan shows when `todo_write` is on (`todo.enabled`). It stays above the input line during
  the turn and goes into the scrollback at the end.
- A failed call is never grouped: it gets its own line in red, with a `✗` mark.

## U5: better diffs

Three steps, in this order:

1. **Word-level marks.** In a changed line, only the changed words are bold:

   ```
   - const key = `${sku}`;
   + const key = `${sku}:${currency}`;
                        ^^^^^^^^^^^^  (bold in the terminal)
   ```

2. **Side by side** when the terminal has 140 columns or more, with the line numbers of both sides.
3. **Syntax colors** for TypeScript, JavaScript, Python, Java, Go, JSON and YAML. See D10.

Hunk review stays as it is, but the approval shows its key in the first line: "3 hunks · h
reviews them one by one".

## U6: rewind timeline and fork

`/rewind` lists the undo points of the session:

```
Rewind to the start of a turn
  ❯ 6  "add the refund rule"          2 files  +14 −3   $0.0062   now
    5  "fix the currency in the key"  1 file   +8 −2    $0.0041   4 min
    4  "explain the cart module"      no files          $0.0009   9 min
    3  "add a test for rounding"      1 file   +22      $0.0033   12 min
  Enter = undo back to here · f = fork a new session from here · Esc = close
```

- **Enter** does what `/undo` does today, one or more turns back, with the same question and
  the same checks.
- **f (fork)** starts a new session. Its messages are the old session's messages up to the point.
  The files go back to the point too, with the same question. The old session stays as it is, so
  `/sessions` can open it again. The new session records where it came from (`forkedFrom`: session
  id and undo point).
- After a compaction, a fork from a point before the compaction is not offered. The messages of
  that point no longer exist.

## U7: morning brief

The night shift writes a digest (`.garuda/jobs/night-<date>.md`). Today the user finds it only
with `/jobs`. The first chat after a night run shows it, once:

```
While you were away: the night shift ran 2 jobs ($0.21)
  ✓ add-csv-export   ready to merge   tests 120 → 126   night/add-csv-export
  ✗ upgrade-undici   needs a look     3 tests fail after the change
  [r] review a branch · [d] diff · [j] /jobs · Enter = go on
```

- The brief reads the job files, not the Markdown digest. A `seenAt` field in the night record
  marks it as seen, so it shows once.
- **r** opens the job's report (verdict, tests, risk flags, the review). **d** shows
  `git diff base…branch` in the pager.

## U8: `garuda advise`

This answers "which model should I use for this repo?" with the user's own code. It builds on the
repo suite (`--from-git`), the evals and `compare`. It adds no new measure.

```
$ garuda advise
Your repo: 14 tasks from the last 200 commits
(each: tests that fail before the commit and pass after it).
Models: claude-haiku-5-5, claude-sonnet-5-5 · 2 runs a task
56 runs, about $0.60.
Start? (y/N) y

  [haiku 23/28] ✓ fix-rounding (6 steps)
  ...

                     passed        cost per accepted change    median time
  claude-haiku-5-5   26 of 28      $0.0041                     24 s
  claude-sonnet-5-5  27 of 28      $0.0390 (×9.5, ×8.1–×11.2)  21 s

Pass rates: no clear difference (−4 to +11 points).
Advice: Haiku for this repo. It passes as often, at about a tenth of the cost.
Report: .garuda/evals/advise-20261105-0912/report.html
```

- The advice follows the eval rules: a difference whose interval contains 0 is "no clear
  difference", and the cheaper model wins a tie. With fewer than 10 tasks, the advice says that
  the result is a rough guide.
- It asks before it starts, with the run count and a cost estimate from the price list. A cost cap
  (`--max-cost`, default $2) stops it before the cap.
- The HTML report is one self-contained file (U11 renders it).

## U9: first-run tour

After `garuda setup`, the first chat in a folder finds out what the project is (the same
detection as `garuda init`) and shows three prompts that fit it:

```
This looks like TypeScript with vitest (pnpm). Some first tasks:
  1. Explain how this repo is laid out
  2. Find the slowest test and say why it is slow
  3. Add a test for the function with the least coverage
Type a number, or your own task. /init sets up GARUDA.md for this project.
```

It shows once per project (a flag in `~/.garuda/trust.json`).

## U10: quiet footer and context bar

```
sonnet-5.5 · ⛨ seatbelt · no network · ▓▓▓▓▓▓░░░░ 62% · $0.0234 · ? keys
```

- The key hints show for the first 5 chats. After that, `?` on an empty input line shows them.
- The context bar turns yellow at 70% and red at 80%, where compaction starts. The number is
  always there too.
- In plan mode, the `PLAN` badge stays first.

## U11: HTML export

`/export --html [file]` writes one self-contained page: the prompts, the answers, each tool call
as a line that opens to show its output, the diffs with color, and the receipts. It comes from the
session file, so secrets are redacted, as for the Markdown export. It has no scripts and no
outside links, so it opens in a browser, a pull request or an email with no risk. Use it as the
evidence in a pull request description.

## U12: reduced motion and screen-reader mode

- `GARUDA_MOTION=reduce`, or `"ui": { "motion": "reduce" }`: no spinner frames. The live line says
  "Working (12 s)" and changes once a second.
- `GARUDA_SCREEN_READER=1`: no boxes and no wordmark. Each receipt row is one plain line that
  starts with its label. Approvals read as "Question. Choice 1 of 3: …".

## Brand

The banner's saffron-to-gold gradient becomes the chat's accent: the spinner, the receipt border,
the plan marks and the selected choice. Cyan stays for links and paths. The accent has a basic
16-color fallback (yellow), and no color under `NO_COLOR`.

## Threat model

| Threat | Control |
| --- | --- |
| A one-key network fix opens more than the user meant. | The question names the host and the preset's hosts. "This project" writes a visible settings line that a review can see. The team policy wins over both. |
| Watch mode lets traffic out. | It allows no host. It records the name and closes the connection. For https it sees only the host name, as today. |
| A receipt shows a secret (a test's output, a command). | A receipt holds counts, file paths and the command's first word only. The output stays behind Ctrl-O, as today. |
| The HTML export runs code in a reader's browser. | No scripts. Every text is escaped. A test feeds `<script>` through a prompt, a tool output and a file name. |
| A fork restores files that the user changed later. | The same checks as `/undo`: `read-tree` refuses a file that changed after the point, and the question lists every file. |
| `advise` spends more than the user expects. | It asks first with an estimate, and `--max-cost` stops it before the cap. |

## Tests

- Each view is a pure function, tested at 80 and 50 columns, with color and with `NO_COLOR`, and in
  screen-reader mode.
- U1: a fake turn with an edit and a test command gives the Files, Tests, Sandbox and Undo rows; a
  turn with no change gives today's line (negative control); a `receipt` record survives
  `--resume` and `--replay`; the test count parser works on a recorded summary line from each
  known runner, and an unknown runner gives only ✓ or ✗.
- U2: a sandboxed command that resolves `registry.npmjs.org` in watch mode records the host and
  makes no connection; each choice gives its note; plan mode, jobs and evals never ask; a host in
  the team policy's `blockedHosts` never asks.
- U3: each stop reason gives its keys; Enter after a step-limit stop runs a turn with the same
  limit.
- U4: three reads in a row give one group line; a failed read is never grouped; `/details` turns
  grouping off.
- U6: a fork has the messages up to the point and `forkedFrom`; the old session file does not
  change; a point before a compaction is not offered.
- U7: the brief shows once; a second chat start does not show it.
- U8: with fake models and recorded results, a tie goes to the cheaper model; an interval that
  contains 0 says "no clear difference"; the cap stops it before the next run.
- U11: the escape test above; the page has no `<script>` and no outside URL.

## Decisions for the user

| ID | Question | Suggested default |
| --- | --- | --- |
| D1 | Receipt for which turns? | Turns that changed files or ran commands. Others keep the one line. Narrowed after the first live run: commands count only when tests ran, one ran outside the sandbox, or a host was blocked. |
| D2 | Test counts: parse the known runners, or only ✓ and ✗? | Parse the six runners above. Unknown runners: ✓ and ✗ only. |
| D3 | Watch mode: start a deny-all proxy in every sandboxed chat (loads `node:http`, against N3 today), or guess the host from the error text? | The proxy. Error text is not reliable. Load it on the first bash call, not at start. |
| D4 | "Allow for this project" writes to `.garuda/settings.json` (in git, so the team sees it) or to `~/.garuda/trust.json` (only this user)? | `.garuda/settings.json`, so it is visible in review. |
| D5 | A "kept change" for the bottom line: a turn that changed files and was not undone? | Yes. |
| D6 | Fork: restore the files too, or only the conversation? | Both, with the `/undo` question. |
| D7 | `advise` defaults: models, runs a task, cost cap. | Haiku and Sonnet of the current family, 2 runs, $2. |
| D8 | Side-by-side diffs from what width? | 140 columns. |
| D9 | Key hints in the footer: for how many chats? | 5, then `?`. |
| D10 | Syntax colors: a dependency (for example highlight.js) or a small tokenizer of Garuda's own? | Word-level marks first. Decide on colors after that, with the dependency audit. |

## As built (patch 1)

- **U1.** `src/app/receipt.ts`: `Receipt`, `hasReceipt` (D1), `isTestCommand` and
  `parseTestCount` (D2: vitest, jest, node:test, pytest, Maven Surefire, `go test -v`; Gradle and
  cargo count as test runs with ✓ or ✗ only), `ReceiptCollector`. Bash reports `commandFacts`
  (exit code, timeout, sandboxed, blocked hosts) through a new `ToolOutcome.command`; the model
  never sees it. `Runtime.runTurn` wraps the loop's events, takes a snapshot at the end only when a
  tool that can change files ran, and writes a `receipt` record. `UndoPoint.changedFiles` makes
  the kept-change count follow `/undo` and `/redo`; at most 50 undo points count. `--replay` does
  not draw receipts; `/export` and `--resume` read them.
- **Views.** `src/cli/receiptView.ts`: a box of at most 76 cells, a Network row for blocked hosts
  (the Sandbox row stays short), plain lines under 60 columns, in a pipe and with
  `GARUDA_SCREEN_READER=1`. `-p --json`: `receipt` in the result line, with snake_case keys.
  Editors (ACP) do not get the receipt yet.
- **U3.** `chatStopMessage` for both chats; after `max_steps` both ask "Go on?" with the approval
  keys (Enter or y, a, n or Esc), not the `[s]` key of the mock-up.
- **After the first live run (patch 1b).** A `find` in the sandbox gave a receipt with "no file
  changed" and nothing else. `hasReceipt` now needs files, tests, a command outside the sandbox or
  a blocked host. The box gets a blank line above it, the footer says `⛨ seatbelt` (not
  `⛨ sandbox seatbelt`), and any context use fills at least one cell of the bar.
- **U10.** `~/.garuda/ui.json` counts chats; hints for 5 (D9), then `? keys`. The context bar has 10
  cells.

## As built (patch 2)

- **U2, watch mode.** `RuntimeOptions.network.watch` (the CLI sets it for a chat only). With no
  allowlist and an OS sandbox, `startNetwork` starts the proxy with an empty list and no consent
  question. It starts at the first turn, not at the first bash call (D3 asked for the bash call;
  the proxy's start is a few milliseconds, and `execPolicy` cannot wait for it). On Linux it needs
  `node` for the bridge, as the allowlist does; without it watch mode stays off with no notice.
- **The question.** The proxy asks while the command runs, with the existing network question
  (once, this session, no), so an allowed command goes on at once instead of failing first. The
  preview says that commands have no network unless the user allows a host.
- **"For this project" (D4).** Garuda does not write `.garuda/settings.json`. After "this session"
  it prints the line that keeps the host (`networkKeepHint`: the preset name, such as `npm`, when
  the host belongs to one). The approval has three answers, and a fourth for one question type
  was not worth a new answer kind. `PermissionDecision.remembered` marks a fresh session answer.
- **Not done:** plan mode, jobs and evals keep their deny with no question (as designed).

## Also in patch 2

- **Requests and answers.** A request has a cyan bar (`▌`) on every line, wrapped lines too (a box
  with only a left border), bold; the first answer
  text of a turn starts with a yellow `✦` (`ChatStore` marks it `lead`). Screen-reader mode: "You:"
  and "Garuda:". The user asked for this after a long chat.
- **An old build.** The chat's banner warns when `BUILD_COMMIT` differs from the checkout's commit
  (`src/buildCheck.ts`, shared with the evals). The user ran an old `dist/` after a patch.

## As built (patch 3)

- **Groups.** `src/cli/chat/toolGroups.ts`: the read-only tools that group (`read_file`, `glob`,
  `grep`, `find_symbol`, `find_references`, `find_callers`, `repo_map`), `groupLine` and
  `groupTargets` (cut to the terminal with "+N"). `ChatStore` keeps the open group live
  (`state.group`) and puts it into the scrollback as one item when another tool, text, a note, a
  receipt or the end of the turn comes. A failed call closes the group and keeps its own line. A
  group of one keeps today's two lines. Only read-only tools group, so `/details` needed no new
  switch; the design's "`/details` turns grouping off" was dropped. The plain renderer does not
  group.
- **Plan.** A `todo_write` result sets `state.plan` (✔ green, ▶ yellow, ○ dim) above the input;
  `end()` prints the last plan once. The marks are the existing ✔ ▶ ○, not the mock-up's ✓ ◐ ○.

## As built (patch 4)

- **U6.** `/rewind` prints the list; `/rewind <n>` and `/rewind fork <n>` act, each after one
  question. The mock-up's picker (↑↓, Enter, f) became a numbered list with arguments, as
  `/sessions` has: it works in the plain chat too, and Tab completes the numbers with each turn's
  prompt as the hint. The details are in [undo.md](undo.md). A fork's new session starts at cost 0;
  `/export` of it says where it came from but does not repeat the old messages.

## Also built: the start screen (0.18.1)

The user asked for a full-screen start, a centred banner and a visible chat box. After a
discussion, the alternate screen stays out: it takes away the terminal's scrollback, search and
copy, and the conversation would leave the terminal at exit. Built instead, in the normal screen:
a clear start that keeps the old screen in the scrollback (`ui.clearOnStart`, default on), a
centred banner, and a round chat box with a hint. A `--fullscreen` option can come later. After
the user's screenshot (a wide terminal, the wordmark small at the left: screen-reader mode was on),
the wordmark got a drop shadow and a double size from 130 columns, and screen-reader mode drops it.

## Patch plan

| Patch | Contents |
| --- | --- |
| 1 | U1 receipt (records, Ink and plain views, JSON), U3 next steps, U10 footer. |
| 2 | U2 watch mode and the one-key network fix. |
| 3 | U4 live plan and grouped tool lines. |
| 4 | U6 rewind and fork. |
| 5 | U5 diffs, step 1 and 2. |
| 6 | U7 morning brief, U9 first-run tour. |
| 7 | U11 HTML export, then U8 `garuda advise` (it uses the HTML report). |
| 8 | U12, and the brand accent. |

Each patch updates the CHANGELOG, this note's "As built", the CLI LLD, the chat guide and the
architecture doc, as usual.
