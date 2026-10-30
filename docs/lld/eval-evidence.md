# Eval evidence (0.17, T11, design)

Status: design approved (2026-10-29). Built: T11a (patch 1: unexpected changes, the stats module,
report v2 and metadata, `--shuffle`, `--seed`; patch 2: `garuda eval compare`); see "As built" in
T11a; T11b (the Claude Code baseline), see "As built" in T11b; T11c (the split and the held-out
set), see "As built" in T11c. T11d is not built yet. The user chose: Claude
Code (`claude -p`) as the baseline agent; a prompt addendum file as the only thing that the
proposer loop may edit; this design note before any code. The user's answers to the open questions
are in "Decisions" at the end.

## Purpose

`garuda eval` can run tasks and repeat them, but its report cannot yet support a claim. It gives
one rate and one mean per task. It does not say how much the rate can move by chance, what one
accepted change costs, whether the agent changed files that the task did not need, or how Garuda
compares with another agent on the same tasks. The review task T11 asks for that evidence:

- repeated runs (n ≥ 3) with their variance;
- success over all attempts;
- cost per accepted change;
- a count of unexpected changes;
- one comparison with a baseline agent.

The user also asked for a method to improve Garuda with that evidence: a frontier model proposes
an edit; an edit stays only when the score on development tasks improves; the result is measured
once on a separate held-out set. Edits come one after another, each on top of the last accepted
one. When a check fails, its failure is the input of the next proposal.

## Summary

| Part | Change | Model calls to build | Where |
| --- | --- | --- | --- |
| T11a | Measurement: intervals, consistency, spread, cost per pass, unexpected changes, run metadata, `eval compare`. | None (unit tests with recorded results). | `src/evals/stats.ts`, `src/evals/runner.ts`, `src/cli/evalCommand.ts` |
| T11b | Baseline runner: the same tasks and grading for Claude Code. | None to build; the user runs it. | `src/evals/agents/claudeCode.ts` |
| T11c | Task split (`dev`, `heldout`) and the first held-out tasks. | None to build. | `src/evals/types.ts`, `src/evals/heldOutTasks.ts` |
| T11d | Proposer loop: `garuda eval tune`, for one prompt addendum file. | The user runs it. | `src/evals/tune.ts` |

All live-model runs are the user's: they cost money, and Garuda's sessions here have no API key.
Every part works with a fake model in the tests.

## T11a: measurement

### Per run

`EvalResult` gets these fields:

- `changed`: the files that the run added, changed or deleted, relative to the task's start state.
  For a written task, the start state is `files`; for a repo task, the worktree at `base` with the
  added tests. Garuda's own folders (`.garuda/`) and build output are left out: `node_modules/`,
  `target/`, `build/`, `dist/`, `__pycache__/`, `.pytest_cache/`, `*.class`, `*.pyc`.
- `unexpected`: the files in `changed` that are not in the task's `solution` and do not match its
  new optional `allowChanges` globs (for example `src/**` for a task that may touch any source
  file). A repo task's expected files are the files of its real commit.
- `attempt`: 1, 2, 3 … for `--repeat`.

An unexpected change does not fail the task. It is a separate count in the report, because a pass
with extra edits is a weaker result. `--strict-scope` (later, not in T11) could make it a failure.

### Per task and overall

With k runs per task (`--repeat k`):

- **Pass rate over all attempts** (error runs count as failures) and over scored runs, as today.
- **Consistency:** the tasks that passed k of k, and the tasks that passed 0 of k.
- **Interval:** a 95% interval for the overall rate, by a cluster bootstrap over tasks. One draw
  takes as many tasks as the suite has, with replacement, and all k runs of each drawn task. 10 000
  draws, a fixed seed (`--seed`, default 1), so the same results give the same interval. Repeats of
  one task are not independent; this keeps that.
- **Spread:** median and p95 of steps, tokens and time; per task, the standard deviation of steps.
- **Cost per accepted change:** the cost of all attempts (passes, failures and error runs) divided
  by the passes. "No passes" when there is none; "unknown" when one run's cost is unknown; "≥ $X"
  when one run's cost is a minimum.
- **Unexpected changes:** runs with at least one, and the total number of files.

### Run metadata

`report.json` becomes version 2. New fields: `schema: 2`, Garuda's version and commit, the model
spec, the provider, the effort, the executor and its isolation, the OS, `seed`, the order of the
runs, and a hash of each task (prompt, files, check, protect, solution), so a later report can show
that the tasks did not change. Version 1 reports stay readable.

### Comparison

`garuda eval compare <a/report.json> <b/report.json>` compares two runs of the same tasks (an A/B
of a setting, or Garuda against the baseline):

- It refuses reports whose task hashes differ.
- Per task: the pass rates of A and B.
- Overall: the difference of the rates (B − A) with a paired 95% interval: one bootstrap draw takes
  tasks with replacement, and for each drawn task both arms' runs. The same seed rule as above.
- Cost per accepted change, unexpected changes and median time for each arm.

The interval decides nothing by itself. A difference whose interval contains 0 is reported as "no
clear difference", never as a win.

### Run order

`--shuffle` runs the task × attempt list in a random order from `--seed`. Without it, the order
stays as today. For a comparison, the user runs both arms with the same seed.

### As built (patch 1)

`src/evals/changes.ts`, `src/evals/stats.ts`, `src/evals/report.ts`; the runner and `garuda eval`
call them. Differences from the plan: the run's start state is hashed after the task files, the
repo task's tests and the formatter's first pass, and `changed` is taken before the check, so the
check's own output never counts. A walk stops at 50 000 files. The interval line needs two tasks
or more. `effort` in the report is "model default": evals set none.

### As built (patch 2)

`src/evals/compare.ts` and `garuda eval compare <a> <b> [--seed n]` (a report.json or its run
folder). It refuses other task ids and changed hashes; a version 1 report (no hashes) compares with
a note. The verdict is "B passes more" only when the whole interval is above 0, "B passes less"
only when it is below 0, else "no clear difference". After the first baseline runs (both arms
passed everything, but the costs differed), `compare` also gives the ratio of the cost per
accepted change (B/A) with the same paired bootstrap and its own verdict; a draw in which an arm
has no pass is skipped, and an unknown cost gives no ratio. Notes: fewer than 10 tasks, other seeds, fewer
than 3 runs of a task. After the user's first live run (2 tasks, all passed, "100%–100%"), the run
report also says when every draw gave the same rate and when there are fewer than 10 tasks.

## T11b: the baseline runner (Claude Code)

`garuda eval --agent claude-code [-m model] [-s suite] [--repeat k]` runs Claude Code on the same
tasks, with the same scratch folders, prompt, time limit and grading (check, protected files,
unexpected changes). Only the agent differs.

### How it runs

```text
claude -p <task prompt> --output-format json --model <model id> --max-turns <max steps>
       --permission-mode bypassPermissions
```

- **Model:** the same Claude model id as the Garuda arm. A non-Claude model is refused.
- **Turns:** `--max-turns` equals Garuda's `--max-steps` (default 50).
- **Isolation:** Claude Code runs in Garuda's OS sandbox, through the Executor (N8): it writes only
  in the scratch folder, temp folders and its own config folder; its network goes through Garuda's
  proxy with an allowlist of `api.anthropic.com` only. `bypassPermissions` is safe only because of
  this sandbox; without an OS sandbox the baseline is refused.
- **Clean config:** `CLAUDE_CONFIG_DIR` points to a new temporary folder per run, so the user's own
  `CLAUDE.md`, settings, MCP servers, hooks and history do not change the result.
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns off telemetry and updates.
- **Key:** `ANTHROPIC_API_KEY` from the user's environment, passed to the sandbox by name. The user
  never types it into a file or a chat. A run without the key is refused before it starts.
- **Usage and cost:** from Claude Code's JSON result (`total_cost_usd`, `usage`, `num_turns`,
  `is_error`, `subtype`). A missing or invalid result makes the run an error run, and its cost
  "unknown".
- **Version:** `claude --version` goes into the report's metadata.

### Fairness and limits

- Both arms get the same prompt text. Claude Code keeps its own system prompt: that is the
  baseline. Garuda gets no addendum in a baseline comparison.
- Claude Code has no token budget; the report shows tokens and cost for both arms instead.
- Claude Code's permission rules differ from Garuda's. Both arms run with every tool allowed in a
  sandbox, which is the fairest common ground.
- A result is valid only for the model, versions and tasks in its metadata.

### As built

`src/evals/agents/claudeCode.ts`, `garuda eval --agent claude-code`. As planned, with these
details: the runner still makes a Garuda runtime for the task (its executor, the policy of bash
and the proxy), but runs Claude Code in it in place of the turn. The new config folder holds a
`.claude.json` with `hasCompletedOnboarding`, so print mode asks nothing; `DISABLE_AUTOUPDATER=1`
too. The API key is read with `providerKeyValue` (the kept key, else the environment) and passed in
the process's environment only. Claude Code's `.claude` folder in the project is left out of the
changed files, as `.garuda` is. The JSON result is saved as `<task>.claude.json`; the cost of a
run with no JSON is unknown. Options that change only Garuda are refused with the baseline.
`report.json` records `agent: { name, version }`. `num_turns` counts Claude Code's turns, close to,
but not the same as, Garuda's model calls. The first live run (macOS, 2026-10-29) failed in every
run with ECONNREFUSED: the runtime starts the allowlist's proxy only in a turn, and the baseline
runs no turn, so Claude Code got no `HTTPS_PROXY`. The runner now calls `runtime.prepareCommands`
first, a test checks the call, and a macOS test checks that the fake `claude` sees `HTTPS_PROXY`
with a listening port in Seatbelt. A connection failure also stops the eval at the first run.

## T11c: task split and held-out tasks

### Split

`EvalTask` gets `split?: "dev" | "heldout"` (default `dev`). All current tasks (26) and tasks from
`--from-git` are `dev`. `--split dev|heldout|all` selects them; the default stays every `dev` task,
so a plain `garuda eval` never runs the held-out set by accident.

### Held-out tasks

The plan in `evaluation-plan.json` asks for at least ten held-out tasks. T11c adds them in
`src/evals/heldOutTasks.ts`, from the capability archetypes, in TypeScript, Python and Java (Go and
Rust need toolchain work first):

| Archetype | Tasks |
| --- | --- |
| multi-file defect | 3 |
| cross-module refactor | 2 |
| missing tests | 2 |
| repository conventions | 2 |
| ambiguous request | 1 |

Each task has a solution, a check that fails before and passes after (unit tests prove both), and
protected files, as the current tasks have. A held-out task's version hash is recorded when it is
added. A held-out task that changes after a tuning result was seen makes that result invalid; the
report says so.

### As built

`src/evals/heldOutTasks.ts` (`HELD_OUT_TASKS`), `chooseTasks` in `src/evals/suites.ts`, and the
shared helpers for written tasks in `src/evals/taskKit.ts`. The
held-out tasks are in no suite, so `-s all` and `ALL_TASKS` stay dev. `--split heldout` takes the
held-out set and `-t` picks in it; `-s` with it is refused. `--split all` takes the dev tasks (`-s`
defaults to `all`) and the held-out set. A held-out id with `-t` on the dev split is refused with
the fix. `report.json` records `split`. The split is not part of the task hash: the hash covers
only what decides a result, so the dev hashes did not change.

The held-out set, second version (the first is now the `medium` dev suite; see below). Each task
has a trap: a quick fix that passes the visible tests, but not the hidden test or the mutation
check.

| Task | Archetype | Language | The trap |
| --- | --- | --- | --- |
| `held-out-price-cache` | multi-file defect | TypeScript | The cache key lacks the currency. Clearing the cache when a session changes currency passes the visible test; two sessions on one service, and a price change seen in each currency, do not. |
| `held-out-payment-retry` | multi-file defect | Python | Each retry gets a new idempotency key. No retry, or a key from the account and amount, passes the visible tests; two equal orders must be two charges, and two lost replies one charge. |
| `held-out-invoice-split` | multi-file defect | Java | Shares do not add up, and `Money.of` reads yen with two decimals. The remainder on the last share passes the visible test; the extra units must come first, refunds too, and yen must be right. |
| `held-out-command-registry` | refactor | TypeScript | Three hand-kept command lists become one registry. A registry for dispatch only passes the visible tests; one `register` call must reach the help and the completion, with the help unchanged to the space. |
| `held-out-settings` | refactor | Python | Settings from three modules into one `load(env)`. The README's table decides, not the old code: `APP_BETA=0` is off, wrong values raise `SettingsError` with the name, and no module reads the environment. |
| `held-out-tests-intervals` | missing tests | TypeScript | Tests must kill 6 subtle mutants: touching intervals, containment, empty intervals, the input copy, the sort, the covered length. |
| `held-out-tests-csv-field` | missing tests | Python | Tests must kill 6 subtle mutants: `@` formulas, CR, quote doubling, a leading space, booleans, CRLF. |
| `held-out-conventions-migration` | conventions | TypeScript | `AGENTS.md`: a new migration (not an edit), `due_date` in the database, an ISO string or `null` in the API, 400 for a bad date, `down` that undoes `up`. |
| `held-out-conventions-reset` | conventions | Python | `AGENTS.md`: the same answer for an unknown address, a rate limit per address, no token in the log, 202 with `{}`. Each trap alone fails the check. |
| `held-out-slow-search` | ambiguous | TypeScript | "Search is slow": one query per tag and a quadratic duplicate scan. A big account must take 3 queries or fewer and under 1.5 s (31 ms fixed, 7.9 s before, here), with the same hits; the batch query sorts and removes repeated ids, so its order must not leak into a hit's tags. |

Prompts that have visible tests say "You may add tests, but do not change the existing ones", and
`allowChanges` covers the test folders: the first set's live run showed that a careful agent adds
a test. Where a hidden test decides and the prompt says nothing about tests, the visible tests are
not protected, but the fixtures and the code under test are (`src/db.ts` in the search task, so
that the query count stays honest; the services in the reset task; the old migrations).

Details:

- **Hidden tests.** The check writes them into `.check/` after the run's changed files are taken,
  so the agent never sees them and they are not its changes. The file is written first: a heredoc
  ends a shell line, so a guard before it (`test -f … &&`) would not stop the test command after
  it. The self-test found this: the conventions task passed before the fix.
- **Mutation checks.** Each mutant is a `sed` expression on a copy of the project; the check fails
  when a mutant does not change the file, so a mutant that stops matching is found. One planned
  mutant (`if not text:` to `if False:`) was equivalent, because the parser refuses empty text
  later as well; it was replaced by one that drops the end-of-text test.
- **TypeScript without a build.** The tasks run with Node's own type stripping (`node --test`,
  Node 22.18 or later), so their code uses only erasable syntax (no parameter properties).
- **Hashes.** `HELD_OUT_HASHES` in `test/evals.heldout.test.ts` holds each task's hash.
- **Quick fixes.** `test/evals.heldout.test.ts` holds the traps as tests: each quick fix must fail
  the check (14 of them, the reset task's three traps one at a time). The search task compares its
  20 000 hits as JSON and names the first difference: `assert.deepEqual` took minutes to build the
  diff of a wrong answer.
- **First set's live run** (2026-10-30, Haiku 5.5, `--repeat 3 --shuffle --seed 7`): 27/30, interval
  70%–100%, about $0.002 a run. `med-export-dates` (then in the held-out set) failed 0/3, each time
  with the right fix: the agent added a CSV test to `test/export.test.ts`, which was protected. A task whose hidden test
  decides need not protect its visible tests, so that task protects nothing and allows changes in
  `test/**`; the two conventions tasks allow a new test (`allowChanges`). Three hashes changed. With
  this fix the run would be 30/30: the set was at its ceiling for Haiku 5.5 too, so it could not
  show a difference between two agents or two prompts. The user chose a harder set. The first set
  moved to the dev split as the `medium` suite (ids `med-…`), so it still guards against
  regressions; the new set above took its place. No tuning result had been seen, so nothing was
  invalidated.
- **Second live run** (2026-10-30, the new set, Haiku 5.5, `--repeat 3 --shuffle --seed 7`):
  28/30, interval 80%–100%, $0.0038 per accepted change, no unexpected changes; steps median 7
  (p95 12), against 5 in the first set. Both failures were `held-out-conventions-migration`, with
  correct work: the agent called the field `dueAt` and the column `due_at`, and the hidden test
  read `dueDate`, a name the prompt did not give. A hidden test may check only what the prompt,
  the repository or its `AGENTS.md` decide; the prompt now names `dueDate` (`due_date` then
  follows from the snake_case rule). The report's reason was empty, because a guard
  (`grep … test/ &&`) stopped the check with no output. Guards now use `guard(test, message)`
  (`taskKit.ts`), which prints the message, and `runCheck` reports "(no output; exit code N)"
  for a silent failure. With these fixes the run would be 30/30: Haiku 5.5 passes this set too.
- **Third live run** (2026-10-30, Haiku 5.5, Garuda and the Claude Code baseline): both ran a
  `dist/` built before 0240, so the old tasks ran, and the reports named the checkout's HEAD. On
  those (same) tasks: Garuda 26/30, Claude Code 27/30, B − A +3 pts (paired interval 0 to +10):
  no clear difference; cost per accepted change $0.0039 and $0.0059, B/A ×1.50 (×1.35 to ×1.71):
  Claude Code costs more, with median tokens 142k against 49k. The migration task failed 0/3 in
  both (the old prompt). One Garuda run of the payment task appended a correct test to the
  protected `tests/test_checkout.py`: the prompt's "do not change the existing ones" read as
  "the existing tests". The prompts now say "in new files … the existing test files".
  `src/buildInfo.ts` holds the build's commit (tsup's `define`; undefined in the tests);
  `buildFields` puts it in `report.json` with the checkout's HEAD when that differs, and
  `staleBuildNote` warns at the start of an eval.
- **Java.** Maven Central is blocked in the cloud workspace, so the Java self-tests skip there.
  The Java tasks were checked with `javac` and a small JUnit stub: their tests fail before the fix
  and pass with it, and in `held-out-invoice-split` the quick fix fails 3 of 4 hidden tests. On a machine with `--prepare java` they run in
  `pnpm check`.

The proposer never gets anything from the held-out set: not its names, prompts, files, results or
traces. The held-out tasks are in the repository, but the proposer is a separate model request
whose input Garuda builds only from dev results.

## T11d: the proposer loop

### What it edits

Only one file: a prompt addendum, a text of at most 4 000 characters. Garuda adds it to the system
prompt in a `<project_addendum>` block, after the project instructions. The eval runner gets a new
option `--addendum <file>`; nothing else in Garuda reads the file. The loop never edits source
code, tool texts, skills or `GARUDA.md`. At the end, the user decides whether to copy the final
text into `GARUDA.md`.

### Command

```text
garuda eval tune --addendum <file> [--proposer claude-opus-5-5] [-m model] [--rounds 5]
                 [--repeat 3] [--heldout-repeat 5] [--margin 2] [--max-cost 20] [--seed 1]
```

### One round

1. **Score the current addendum** on the dev split, k runs per task (once at the start; later
   rounds reuse the score of the last accepted version).
2. **Propose.** One request to the proposer model, with no tools. Input: the current addendum; for
   each failed or error dev run, the task id, prompt, stop reason, the last 40 lines of the check
   output and the unexpected files; the history of earlier proposals with their score and decision.
   Output: a complete new addendum and a one-paragraph reason. A text over the limit, or one that
   asks to skip or weaken checks, protected files or the sandbox, is rejected without a run (a
   fixed list of phrases, and the size limit).
3. **Score the candidate** on the same dev tasks with the same seed.
4. **Keep or drop.** Keep it when it passes at least `--margin` more runs over all attempts than
   the current version (default 2), and no task goes from k of k to 0 of k. Otherwise drop it. Both
   decisions and both scores go into the history.
5. **Feed back.** The next proposal starts from the kept version, with the candidate's failures in
   its input: the failed checks of one candidate are the next prompt.

The loop stops after `--rounds`, or when the next round would pass `--max-cost` (USD, from the
reported cost; an unknown cost stops the loop).

### The held-out measurement

After the last round, Garuda runs the held-out split once with the empty addendum and once with the
final addendum, k runs per task, with the same seed and the shuffled order. The report is a
`compare` of the two (T11a). The held-out result decides nothing in the loop; it is the only number
to quote.

### Output

`.garuda/evals/tune-<id>/`: every addendum version (`v0.md`, `v1.md` …), each dev report, the
proposer's inputs and answers, `history.json` (scores, decisions, costs), and the held-out
comparison. Garuda changes no file outside this folder.

### Cost

One dev round is k × (number of dev tasks) runs. With the 20 regression tasks and k = 3, that is
60 runs per score, two scores in round 1 and one per later round. The command prints this count
and the estimated cost range before the first run and asks to continue.

## Threat model

| Threat | Control |
| --- | --- |
| The baseline agent runs with every permission and changes files outside the task. | It runs in the OS sandbox: writes only in the scratch folder, temp folders and its own config folder; network only to api.anthropic.com. No sandbox: no baseline run. |
| The user's API key leaks into reports or session files. | The key goes to the sandbox by name; reports store no environment; Garuda's redactor covers what it writes. |
| The proposer learns the held-out set. | Its input comes only from dev runs. The held-out split is never in its input. |
| The proposer writes an addendum that tells the agent to skip checks or edit tests. | Protected files and checks still decide the score; a text with such phrases is rejected before a run; the user reviews the final text. |
| Noise looks like an improvement. | The margin, the "no k-of-k to 0-of-k" rule, the fixed seed, and the held-out measurement with an interval. |
| Tasks change between runs that are compared. | Task hashes in each report; `compare` refuses different hashes. |

## Tests

- T11a: recorded result sets (no model) give known intervals, consistency counts, spreads and cost
  per pass; a run that adds a file outside the solution counts as unexpected; build output does
  not; `compare` refuses different task hashes; the same seed gives the same interval.
- T11b: a fake `claude` script on the PATH returns a JSON result; the runner grades it as a Garuda
  run; a missing key, a non-Claude model and a host executor are refused; the policy has the
  scratch folder writable and only api.anthropic.com in the allowlist.
- T11c: every held-out task fails before and passes with its solution; `--split` selects; the
  default never includes held-out tasks.
- T11d: with a fake proposer and a fake model, an edit that adds two passes is kept, one that adds
  one is dropped, one that drops a task from k/k to 0/k is dropped; the proposer's input never
  contains a held-out task id; `--max-cost` stops the loop; a rejected phrase never runs.

## Decisions (the user, 2026-10-29)

Each value is a default; every one is an option the user can change.

1. **Margin:** 2 more passes over all attempts (`--margin 2`; 60 runs with 20 dev tasks × 3).
2. **Repeats:** k = 3 in the loop (`--repeat 3`). The one held-out measurement keeps k = 5
   (`--heldout-repeat 5`), as proposed.
3. **Models:** the proposer is a frontier model, by default Opus 5.5 (`--proposer
   claude-opus-5-5`). The agent has no fixed default: `-m`, else the configured model, so the user
   picks a low-cost model that is good enough.
4. **Budget:** `--max-cost 20` (USD) for one tuning run.
5. **Claude Code key:** an API key in `ANTHROPIC_API_KEY`. Garuda passes it to the sandbox by name
   only (the environment allowlist), never writes its value to a report, a session or the audit
   log, and the network allowlist opens only `api.anthropic.com`. A subscription login (macOS
   Keychain) stays unsupported: the sandbox denies the Keychain on purpose.

## Patch plan

| Patch | Part |
| --- | --- |
| 1 | T11a: unexpected changes, stats module, report v2 and metadata, `--shuffle`, `--seed`. |
| 2 | T11a: `garuda eval compare`. |
| 3 | T11b: the Claude Code runner. |
| 4 | T11c: `split`, `--split`, and the ten held-out tasks. |
| 5 | T11d: `--addendum` and `garuda eval tune`. |

Each patch: tests that fail without it, the full checks, and docs (README eval section, LLD evals,
this note's "as built", CHANGELOG).
