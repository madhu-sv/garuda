# Scheduled jobs (`src/jobs/`, `src/cli/jobCommand.ts`, 0.7)

## Purpose

Build a finished plan later, with nobody at the keyboard: overnight, for example. The user approves once,
when the job is made; the run then asks nothing. The job works on its own branch in its own worktree, so
the user's checkout never changes, and a report says what happened.

## Flow

```mermaid
sequenceDiagram
  participant U as User (chat)
  participant RT as Runtime
  participant J as .garuda/jobs/<id>.json
  participant R as garuda run <id>
  participant W as worktree (garuda/job-<id>)
  U->>RT: plan-mode turn ends (done): lastPlan
  U->>RT: /schedule [HH:MM]
  RT->>RT: base commit, ```permissions rules, links
  RT->>U: one question (the rules, the base, the branch)
  RT->>J: job (status scheduled)
  U->>R: garuda run <id> [--at 01:00]
  R->>R: wait until HH:MM (optional)
  R->>W: git worktree add -b garuda/job-<id> <base>; link node_modules …
  R->>R: Runtime in the worktree: job rules, unattended engine, approver "deny"
  R->>R: one turn (the job prompt)
  R->>W: commit (no hooks; no links, no Garuda files)
  R->>J: result, status; <id>.md report; notification
```

## Files

| File | Role |
| --- | --- |
| `jobs/job.ts` | The job format (Zod), `newJobId`, `saveJob` (temp file + rename, 0600), `loadJob` (checks the file and every rule again), `listJobs`, `planPermissions`, `planTitle`. |
| `jobs/create.ts` | `createJob`: the checks, the question, the job file. `Runtime.scheduleJob` calls it. |
| `jobs/worktree.ts` | `jobBase`, `linkCandidates`, `worktreeDir`, `prepareWorktree`, `commitJob`, `jobChanges`. |
| `jobs/git.ts` | `git(executor, cwd, args)` and `hostCommand` (launchctl, osascript): through the Executor (N8), outside the sandbox; git with the user's config but `core.hooksPath=/dev/null`. |
| `jobs/launchd.ts` | The launchd agent (macOS): `agentPlist`, `installAgent`, `removeAgent`, `nextTime`, `defaultAgentEnv`. |
| `jobs/proof.ts` | Proof of work (0.11): `detectTestCommand`, `riskFlags`, `stackOf`, `reviewerSystem`, `reviewPrompt`, `parseReview`, `jobVerdict`. |
| `jobs/night.ts` | The night shift (0.11): `nightQueue`, `processRunner`, `runQueue`, `nightDigest`, `writeDigest`. |
| `jobs/text.ts` | `jobPrompt` (the task for the unattended run) and `jobReport` (Markdown). |
| `cli/jobCommand.ts` | `prepareJob` (load, `--at` wait, worktree, settings, status running) and `finishJob` (commit, result, report, notification), `msUntil`. |

## The job file

`<root>/.garuda/jobs/<id>.json` (id `YYYYMMDD-HHMM-xxxx`). The user may edit it before the run; `loadJob`
checks it again (schema, id, root, rules).

| Field | Meaning |
| --- | --- |
| `title`, `prompt`, `planSession` | The request's first line; the task (request + plan + the rules of an unattended run); the plan's session. |
| `root`, `base`, `branch`, `worktree` | The checkout; the start commit; `garuda/job-<id>`; `~/.garuda/worktrees/<project>-<hash>/<id>`. |
| `model` | The chat's model at scheduling time; `garuda run -m` overrides it. |
| `allow` | Permission rules for this job only, in the settings format. |
| `onUnapproved` | `deny-and-continue` (the only mode in 0.7). |
| `at`, `maxSteps`, `links` | The time given to `/schedule`; the step limit (100); linked ignored folders. |
| `queue` | In the project's night queue (0.11); `/schedule` sets it. |
| `network` | The network allowlist (0.13) in effect in the chat at `/schedule` (the question shows it). The run uses it, not the project's current list, with no consent question; other hosts are denied and appear in the report's denied calls. Absent: no network. |
| `test`, `review` | Proof of work (0.11): the test command run before and after (absent: none); the review (default true). |
| `status`, `startedAt`, `endedAt`, `result` | `scheduled` → `running` → `done`, `stopped` (Ctrl-C) or `failed`; the result: stop reason, steps, tokens, cost, time, session, commit, files with line counts, denied calls, the agent's last answer. |

## Making a job (`/schedule [HH:MM]`)

- Needs a finished plan: `Runtime.runTurn` keeps the last assistant text of a plan-mode turn that ended
  `done`, with its prompt and session (`lastPlan`).
- `PLAN_NOTE` asks each plan to end with a ```` ```permissions ```` block: one rule per line for what the
  build needs beyond the sandbox (`edit_file(path)`, `write_file(path)`, globs; `bash(command)` for the
  network; `web_fetch(host)`). `planPermissions` keeps the lines that parse; the others are shown as "Not
  rules, left out".
- Refused without an OS sandbox (every command would ask) and without a git repository with a commit.
- The base (`jobBase`): HEAD; with uncommitted changes of tracked files, one plain commit on HEAD that holds
  them (`git stash create`, then `commit-tree` on its tree: the branch history stays linear, and the user's
  stash list and checkout do not change). Untracked files are counted (not Garuda's own) and named in the
  question.
- Links: `node_modules`, `.venv`, `venv` when they exist in the checkout.
- One question shows the title, model, base, branch, links and the rules; "Yes" writes the file and prints
  `garuda run <id> [--at HH:MM]`.

## Running a job (`garuda run <id> [--at HH:MM] [-m model]`)

1. `prepareJob`: load; refuse `running` (a crash leaves it; the message says how to reset) and `done`.
   `--at` waits until the next HH:MM in local time (Ctrl-C cancels; the job stays scheduled).
2. The worktree: `git worktree add -b <branch> <worktree> <base>` (or the existing branch after an earlier
   run); symlinks for the links.
3. Settings: the worktree's `.garuda/settings.json` (its parts that loosen safety only when the user
   pinned them for the main checkout: `gateProjectSettings`, no question), plus the job's rules in
   `allow`, `maxSteps`, and the links' real paths as sandbox write paths (tool caches).
4. The CLI builds the runtime as for `-p`, with root = the worktree, the session store of the checkout (the
   session file stays out of the branch), the approver `AutoApprover("deny")` (consents for project MCP
   servers, hooks, skills, agents and Claude's search all get "no"), no undo snapshots (the branch is the
   safety net), and `unattended` for the engine. Without an OS sandbox the run stops (status `failed`).
5. One turn with the job prompt. The engine allows reads, commands in the sandbox and the job's rules; a
   call that would ask is denied with `JOB_DENIAL` ("not in the approved list … continue without it … list
   it") and recorded.
6. `finishJob`: `git add -A` without `.garuda/sessions|index|evals|jobs` and the links, a commit with no
   hooks (`Garuda job <id>: <title>`, plus the stop reason when it did not end `done`), the changed files
   (`diff --name-status` and `--numstat` from the base), the result in the job file, the report in
   `.garuda/jobs/<id>.md`, and a notification (OSC 9 or the bell) when stdout is a terminal.

## launchd (macOS)

`/schedule HH:MM` on macOS asks a second question: "Run the job at 01:00 with launchd?". Only the chat
offers it (`createJob` needs the `launchd` option), so no other caller and no test installs an agent. Yes:

- `~/Library/LaunchAgents/dev.garuda.job.<id>.plist`: `ProgramArguments` =
  `/usr/bin/caffeinate -i <login shell> -lic "cd <root> && exec <node> <garuda script> run <id> --from-launchd"`
  (the single binary has no script). The login shell (`$SHELL` if zsh or bash, else `/bin/zsh`) with `-lic`
  reads `.zprofile` and `.zshrc`, so the API keys and `GARUDA_MODEL` come from the user's setup; no key
  is written to a file. `caffeinate -i` stops idle sleep while the job runs.
- `StartCalendarInterval` with Month, Day, Hour and Minute of the next HH:MM: it fires once. If the Mac
  sleeps then, launchd starts the job at the next wake. `RunAtLoad` false. Output goes to
  `.garuda/jobs/<id>.log`.
- `launchctl bootout` (an earlier agent, errors ignored), then `launchctl bootstrap gui/<uid> <plist>`.
  The job file keeps `launchd: { label, plist, when }`.
- The run removes the agent at its very end, after the report and a macOS notification (`osascript`, the
  text as an argument, never as script text): delete the plist, then `launchctl bootout`, which also ends
  the run's own process. A run from the agent that does not start (done, running, broken file) removes the
  agent too, and so does a manual `garuda run` of a job that has one.
- `/jobs cancel <id>`: removes the agent and sets `stopped`; `garuda run <id>` can still run it.
- Waking the Mac at a set time needs `sudo pmset schedule wake "<date>"`; Garuda never runs sudo.

## The Batch API (0.7)

For a Claude model, `/schedule` asks "Use the Batch API for this job?" (preview: half price, the uneven
wait, the step limit, the switch time). Yes sets `batch: true`, `finishBy: "07:00"` and
`stepLimitMinutes: 20` in the job file (the user may change both). At run time the CLI builds a
`DeadlineClient`: the Batch API until 15 minutes before the next `finishBy`, then the normal API for the rest
of the job; before that, a step that waits more than the step limit is cancelled and runs on the normal
API, and the next step tries the Batch API again. The run prints the switch time with its date, the batch
id of each step and a line per minute of waiting. The result keeps `modelCalls: { batch, normal, slow,
switchedAt? }`, and the report shows them.

Why the step limit: the first measurement waited about 3 minutes per step, but the next day one batch
stayed `in_progress` for more than 6 hours. Only the slow steps pay full price. Costs are exact per
response: batch responses at half the token price.

## Proof of work (`jobs/proof.ts`, 0.11)

- `detectTestCommand(root, profiles)` at `/schedule`: a `test` script in package.json (pnpm, yarn or
  npm by the lock file; not npm's placeholder), else the first profile's `test`, else `node --test` when
  the root or `test/` holds `*.test.{js,mjs,cjs}` files. It goes into the job
  file as `test` (the user may change it) and into the question's preview.
- Before the turn, `testsBefore` (the CLI, after the runtime is built) runs it with `runtime.runCheck`:
  the sandbox and bash's policy, outside the permission engine, 10 minutes at most. Then `git checkout
  -- .` and `git clean -fdq -e /<link>…` (`cleanArgs`) put the worktree back at its base, so test output
  never reaches the commit. The `-e` keeps the links: a symlink is not a folder, so a `node_modules/` line
  in `.gitignore` does not protect it (fixed in 0.12; before, a job's tests after the change could not
  find `vitest`).
- After the commit, `proveJob` (in `finishJob`, not after Ctrl-C) runs the tests again, then
  `riskFlags` (pure): STOP = not `done`, an error, tests fail after; look = no test command, test files
  deleted or changed, manifests or lock files, CI/container/`.env` files, more than 20 files or 500 lines,
  denied calls, tests fixed by the job, no file changed.
- The review (`job.review` not false, and a commit): `runtime.askModel(reviewerSystem(stack),
  reviewPrompt(...))`, one request with no tools and no session. The role: a principal engineer and a
  domain expert in the stack (`stackOf`: languages of the changed files, then the profiles' labels). The
  input: the job prompt, the files, the test results (the failing output), the flags and `git diff base
  branch` (cut at 60,000 characters). `parseReview` reads `VERDICT: ready | needs a look`; no verdict line
  counts as "needs a look". A failed review is recorded (`reviewError`), never an error of the job.
- `jobVerdict`: any STOP flag → needs a look; else the review's verdict; with no review, ready only
  with no flag. The result keeps `proof` (verdict, test runs with the last 30 lines, flags, review text
  and cost). The report puts Verdict, Tests, Risk flags and the review first; the notification says
  "ready to merge" or "needs a look".
- The builder's role is in `jobPrompt`: a staff engineer, small focused changes, tests for each change.

## The night shift (`jobs/night.ts`, `cli/nightCommand.ts`, 0.11)

- `/schedule` puts each new job in the queue (`queue: true`; the question says so). `nightQueue(root)`:
  the jobs that are `scheduled`, in the queue and without a launchd agent of their own, oldest first.
- `garuda night [--at HH:MM] [--parallel n]` waits (Ctrl-C cancels), then `runQueue` runs the jobs up to
  `parallel` at a time (default 3, at most 10). Each job is its own process, `garuda run <id>`
  (`processRunner`: the host executor, in the project, with this process's environment so the API keys
  come along, output appended to `.garuda/jobs/<id>.log`, 24 h at most). The worktrees keep the jobs
  apart; each job still does its own proof of work and report, and does not notify.
- At the end the command reloads the job files and writes one digest, `.garuda/jobs/night-<date>.md`
  (`nightDigest`): a row per job (verdict, tests after, files, cost with the review, branch), then the
  jobs that need a look with their flags and the review's summary. It sends one notification
  ("N job(s), M ready to merge") when stdout is a terminal.
- `/jobs delete <id>` (`jobs/remove.ts`, `Runtime.deleteJob`): refuses a running job; `jobLeftovers`
  finds the files, the worktree and the branch (merged = an ancestor of HEAD); one question (an unmerged
  branch adds "Yes, but keep the branch"); then the launchd agent, `git worktree remove --force` and
  `prune`, `git branch -D` only when chosen, and the files.
- `/jobs` marks queued jobs ("in the night queue") and verdicts.
- The queue's launchd agent (`launchd.ts`: `AgentSpec`, `nightSpec`, `specPlist`, `installSpec`,
  `removeSpec`, `nightAgentTime`): `/schedule HH:MM` on macOS asks "Start at HH:MM with launchd?" with
  three answers: the whole night queue (the agent `dev.garuda.night.<project>-<hash>` runs `garuda night
  --from-launchd`, log `.garuda/jobs/night.log`; an earlier agent of the project is unloaded and
  replaced), only this job (the 0.7 agent; the job leaves the queue), or no. `garuda night
  --from-launchd` sends a macOS notification (`osascript`, the text as an argument) and removes the
  agent last. `/jobs` shows the agent's time (read from its plist); `/jobs cancel night` removes it.

## Safety

- The user approves the list once, with the rules in view; nothing else can be approved later.
- Deny rules, sensitive files and `.git/` writes still win over the job's rules (the engine's order holds).
- The job never touches the user's checkout, index or stash; its commit runs no repository hooks (a cloned
  repo's hook would run outside the sandbox).
- Commands run only in the OS sandbox; there is no host fallback for jobs.

## Later

Measure the Batch API on longer jobs (the hard suite with `--batch on`). Measure how often a step hits the
step limit (`modelCalls.slow` in the job results) before a change of the default.

## Tests

`test/jobs.test.ts`: the permissions block; the unattended engine; `msUntil`; `createJob` (the file, the
question, No, a dirty checkout's base, no git, no sandbox); a whole run in the worktree with a fake model
(an approved edit on the branch, a denied write in the report, links and sessions not committed, the
checkout unchanged, a done job not run again); `/schedule` and `/jobs` in the chat; the launchd plist, the
second question, install and `/jobs cancel` (launchctl recorded, not run).

`test/batch.test.ts`: the batch client (a batch of one, overloaded and expired results, an abort cancels the
batch, half prices); eval tasks at the same time; the `DeadlineClient` (the switch time, an abort is not a
switch, a slow step and the retry at the next step); the batch id, the wait lines and a failed status check.
