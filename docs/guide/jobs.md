# Scheduled jobs and the night shift

Plan now, build later on its own branch, with tests before and after and a review.

## Scheduled jobs (0.7)

A plan can run later, with nobody at the keyboard: for example overnight.

1. Make a plan in plan mode (`/plan`, then your task). Each plan now ends with a `permissions` block: the
   file edits and network commands the build needs.
2. At "Build this plan?", choose "No, keep planning", and type `/schedule 01:00` (the time is optional).
   Garuda shows the approval list, where the job starts (your last commit, plus your uncommitted changes
   of tracked files) and its branch, and asks once.
3. In a terminal in the project folder: `garuda run <job-id> --at 01:00`. It waits, then builds the plan in
   its own worktree on the branch `garuda/job-<id>`. Your checkout does not change.

- The job asks nothing. Reads, commands in the sandbox and the calls in its list are allowed; any other call
  is denied, and the job goes on and reports it. You can edit the list (`"allow"`) in
  `.garuda/jobs/<id>.json` before the run.
- The write scope (0.17): `/schedule` also proposes `"writeScope"`, the paths in the worktree that the
  job may change: the folders and files of the plan's `edit_file` and `write_file` rules, and the
  build folders of the project (`target/`, `build/`, `dist/` …). The question shows it. The OS sandbox
  makes the rest of the worktree read-only for the job's commands, the engine denies edits outside
  it, and a change outside it fails the job with no commit. A rule with no folder (`edit_file(**/*.ts)`)
  gives no scope: the question then says that commands may write anywhere in the worktree. Jobs made
  before 0.17 have no scope. The scope holds for every command of the job, also its test command
  (proof of work), and a job never runs a command outside the sandbox, whatever its rules say. A test
  that writes a file outside the scope (for example `coverage.txt` in the root) fails; add a folder
  for it to `"writeScope"`. An edit through a symbolic link must reach a path in the scope too.
- A job needs git and the OS sandbox. `node_modules` and `.venv` are linked from your checkout.
- At the end Garuda commits the changes on the job branch (no git hooks run) and writes a report:
  `.garuda/jobs/<id>.md`, also shown by `/jobs <id>`. Review with `git diff`, then `git merge
  garuda/job-<id>`, and remove the worktree.
- `/jobs` lists the jobs. Keep the Mac awake and on power while the terminal waits.
- `/jobs delete <id>` (0.11) asks, then removes the job file, report, log and worktree. An unmerged job
  branch may hold work: you choose to keep it or delete it too. A running job cannot be deleted.
- On macOS, `/schedule HH:MM` offers a launchd agent: the job then starts at that time also with no
  terminal open. It runs through your login shell (so your `.zshrc` gives it the API keys) under
  `caffeinate`, logs to `.garuda/jobs/<id>.log`, and sends a macOS notification at the end. If the Mac
  sleeps at that time, the job starts at the next wake (`sudo pmset schedule wake "<date>"` can wake it).
  `/jobs cancel <id>` removes the agent.
- With a Claude model, `/schedule` also asks whether the job should use the Batch API: half the token
  price, but each step waits for its batch: about 3 minutes in the first measurement, sometimes hours.
  A step that waits more than 20 minutes (`"stepLimitMinutes"`) runs on the normal API, and the next step
  tries the Batch API again. 15 minutes before the finish-by time (`"finishBy": "07:00"` in the job file)
  a job that still runs goes on with the normal API. The run prints the batch id and a line per minute
  of waiting.

### The night shift (0.11)

Each `/schedule` also puts the job in the project's night queue. `garuda night --at 01:00` waits, then
runs the queued jobs, up to 3 at a time (`--parallel n`, 1 to 10), each in its own worktree and with its
own log (`.garuda/jobs/<id>.log`). At the end it writes one digest, `.garuda/jobs/night-<date>.md`: a row
per job with its verdict, tests, files, cost and branch, and why the others need a look. `/jobs` shows
which jobs are in the queue. A job with its own launchd agent is not in the queue.

On macOS, `/schedule HH:MM` asks whether launchd should start **the whole night queue** at that time
(one agent per project, `garuda night` through your login shell under `caffeinate`, log
`.garuda/jobs/night.log`, a macOS notification at the end), **only this job**, or nothing. A later
`/schedule HH:MM` moves the queue's agent to the new time. The agent removes itself after the run;
`/jobs` shows it, and `/jobs cancel night` removes it.

### Proof of work (0.11)

Each job report starts with a verdict: **Ready to merge** or **Needs a look**. It rests on three things:

- **Tests before and after.** Garuda finds the test command (a `test` script in `package.json`, run with
  pnpm, yarn or npm by the lock file; else the Maven, Gradle or pytest command; else `node --test` when
  there are `*.test.js` files) and runs it in the sandbox
  at the job's base and again after the job. `"test"` in the job file changes or sets it.
- **Risk flags.** STOP: the job did not finish, or the tests fail after it. Look: no test command, test
  files deleted or changed, dependency or build files changed, CI or environment files changed, a large
  change, denied calls, tests that failed before and pass after.
- **A review.** The job's model works as a staff engineer. A second request to the same model, as a
  principal engineer who knows the project's stack, reads the request, the plan, the diff, the test
  results and the flags, and answers `VERDICT: ready | needs a look` with findings. It costs one model
  call (shown in the report); `"review": false` in the job file turns it off.

A STOP flag always means "Needs a look"; otherwise the review decides.
