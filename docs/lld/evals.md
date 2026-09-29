# Evals (`src/evals/`, `src/cli/evalCommand.ts`)

## Purpose

Measure the agent on fixed tasks (N5): pass rate, steps, tokens, cost and time. Compare changes with
same-build A/B runs.

## Parts

| File | Role |
| --- | --- |
| `types.ts` | `EvalTask` (id, title, prompt, files, check command, protected files, required toolchains, reference solution) and `EvalResult`. |
| `tasks.ts` | Basic suite: 10 small tasks (fix a failing test, off-by-one, rename, implement, missing await, CSV quotes, write tests, config default, new module, extract helper). |
| `shopkit.ts` | A generated repository of about 107 files (entities, services, API) for the hard suite. |
| `hardTasks.ts` | Hard suite: 6 tasks on shopkit (rounding, event, import, rename across files, unused code, coupon). |
| `javaTasks.ts` | Java suite (0.3): 5 Maven projects with JUnit 5 (paginator boundary, equals/hashCode with `BigDecimal`, rename across classes, LRU cache from tests, stream report with two bugs). |
| `pythonTasks.ts` | Python suite (0.3): 5 pytest projects in src layout (shared mutable default, last short chunk, rename across modules, duration parser from tests, sort order of equal scores). |
| `projects.ts` | The shared `pom.xml` (fixed plugin and JUnit versions) and `pyproject.toml`, the Java and Python check commands, and `isProtectedPath`. |
| `toolchains.ts` | The `maven` and `pytest` toolchains: a probe project, `checkToolchains`, `prepareToolchain`. |
| `suites.ts` | `basic`, `hard`, `java`, `python`, `all`; `requiredToolchains(tasks)`. |
| `repoTasks.ts` | Benchmark your repo (0.12): candidate commits from git history (`skipReason`, `recentCommits`), `repoPrompt`, `taskWorktree` / `applyTests` / `removeTaskWorktree`, `buildRepoSuite`, `saveRepoSuite` / `loadRepoSuite`, `repoEvalTasks`. |
| `runner.ts` | Runs tasks; `formatReport`. |

## Runner

For each task (and each repeat):

1. Create a scratch folder in the temp directory; write the task files. A repo task (0.12) gets a git
   worktree of the project at the commit's parent (detached, `node_modules` and venvs linked), with the
   commit's test files added.
2. Snapshot the protected files. Default: tests (`test/`, `tests/`, `src/test/`) and build files
   (`pom.xml`, `pyproject.toml`). A task can list its own.
3. `Runtime.create` with an `AutoApprover("once")`, deny rules (`rm -rf*`, `sudo*`, `git push*`, `curl*`,
   `wget*`), `mcp: false`, `hooks: false`, `web.enabled: false`, and the chosen executor and code index mode.
4. `runTurn(prompt)` with a 10-minute limit.
5. Pass when the protected files are unchanged and the check command (for example `node --test`) exits 0.
   The check runs on the host with a 120 s limit (5 min for a repo task). A repo task's worktree is removed
   after the run (`git worktree remove`), unless `--keep`.
6. Copy the session file to `.garuda/evals/<run-id>/<task>.jsonl` (`-2`, `-3` … for repeats).

## Java and Python suites (0.3)

Each task is a small project. The Java tasks share one `pom.xml` with fixed versions (JUnit 5.11.4,
resources 3.3.1, compiler 3.13.0, surefire 3.5.2, Java release 17), so a run does not depend on the
defaults of the installed Maven version, and one download serves every task.

Checks, and why they look like this:

| Suite | Check | Guard against |
| --- | --- | --- |
| java | `test ! -e .mvn && mvn -B -q -o test` | `.mvn/maven.config` could add `-DskipTests`; no task has a `.mvn` folder. Offline: evals never download. |
| python | `python3 -m pytest -q -c pyproject.toml --noconftest -p no:cacheprovider` | A new `pytest.ini` or `conftest.py` could skip or deselect tests. `-c` reads only the protected `pyproject.toml`. |

With the protected build files, the agent cannot pass by changing the tests or the test setup.

In the agent run, the scratch folder has a `pom.xml` or `pyproject.toml`, so the runtime detects the
language profile (see [languages.md](languages.md)): the model gets the build notes, and Maven may write
`~/.m2/repository` in the sandbox.

### Toolchains

A task lists the toolchains that its check needs (`requires`). `checkToolchains` runs each toolchain's
probe project in a scratch folder with no sandbox and a 120 s limit:

| Toolchain | Probe | Prepare |
| --- | --- | --- |
| `maven` (alias `java`) | `mvn -B -q -o test` on a one-test project | `mvn -B -q test` on the same project (network, 10 min limit): downloads the plugins, the surefire JUnit provider and JUnit into `~/.m2`. |
| `pytest` (alias `python`) | `python3 -m pytest -q` on a one-test project | None: the user installs pytest. |

`garuda eval` checks the toolchains of the chosen tasks before the first model call. When one is missing,
it prints the hint and the first lines of the probe output, and exits with 1: a missing toolchain would
fail every task and waste model calls. Evals never download anything by themselves; `--prepare java` does
it once, when the user asks.

The check and the probes get `JAVA_HOME`, `GRADLE_USER_HOME` and `VIRTUAL_ENV` on top of the default
environment list.

## Command

```text
garuda eval [-m model] [-s basic|hard|java|python|all|repo] [-t ids…] [--repeat n] [--index off|lookup|all]
            [--executor auto|os|host] [--max-steps n] [--keep] [--list]
            [--subagents on|off] [--subagent-model spec] [--todo on|off] [--lsp on|off]
            [--keep-thinking on|off] [--format on|off]
            [--batch on|off] [--parallel n]
garuda eval --prepare java|python
garuda eval --from-git [--commits n] [--since date] [--max-tasks n] [--test-command cmd]
```

`--list` shows the toolchains that each suite needs, and the repo suite when the project has one.

## Benchmark your repo (0.12, W3)

The fixed suites measure Garuda on Garuda's tasks. The repo suite measures it on the user's own code, so
a user can check a model, a setting or a Garuda version on the work they do.

`garuda eval --from-git` builds the suite from the project's recent commits (default 200, newest first;
`--since` narrows them), in the git root of the current folder:

1. File rules (`skipReason`): skip a commit with no files, more than 10 files (docs do not count:
   Markdown, text and `docs/`), a binary file, a changed lock file or non-npm manifest (the worktree links
   the checkout's `node_modules`), no test change, or only test changes. A changed `package.json` is
   skipped only when its diff changes dependencies (`dependencyChange`); a version or script change is
   fine. Merges are not read. Test files match `TEST_PATH` from proof of work.
2. The tests prove the task: in a worktree at the commit's parent, with the commit's test files added
   (a deleted test file is deleted), the task's tests must fail; at the commit they must pass. Else the
   commit is skipped ("the tests already pass at the parent", "the tests fail at the commit"). The
   output shows the end of the first failure at a commit, so a command that cannot run in a worktree is
   easy to see.
   The task's tests: `scopedTestCommand` gives the commit's test files to the runner (pnpm, yarn, npm with
   `--`, `node --test`, vitest, jest, pytest; `{files}` in `--test-command` for any other). Other runners
   (Maven, Gradle, Go) run the whole suite. Only the task's files is faster, and other tests that fail on
   this machine do not hide the task. The command is saved per task as its check.
3. Stop at `--max-tasks` (default 30). The test command is `--test-command`, else the one that jobs use
   (`detectTestCommand`). Both runs are on the host, with no sandbox, as eval checks are; the output says
   so. The user's checkout does not change.
4. Save `.garuda/evals/repo-suite.json` (version 1: root, HEAD, test command; per task the commit, its
   parent, the subject, the prompt and the test files' content). Print the kept count and the skip
   reasons.

The task prompt is the commit message, then the visible tests: "The tests for this change are already in
the project: … Make the change so that they pass. Do not change these test files." (as SWE-bench gives
the failing tests). The check is the task's test command; the protected files are the task's test files, so
the agent cannot pass by editing them.

`garuda eval -s repo` loads the suite of the current project (the git root replaces the saved root, so
a moved checkout works) and runs it like any suite: `--repeat`, `--parallel`, `--batch` and the A/B
flags work. `--format` does not (it would format the whole project). `-t` picks from the repo suite.

First live test (garuda, 40 commits, cloud): 21 tasks kept from 22 candidates in 2 minutes. The first
Mac run kept none: `git clean` removed the `node_modules` link at the commit, and the whole suite ran
(both fixed in 0104).

Limits: a runner that cannot take files runs the whole suite, so a slow suite makes a slow task (5 min
limit per check). A commit that needs a new dependency is skipped. Build the suite again after new commits; old
tasks stay valid while their commits exist.

`-m` takes any model spec, for example `garuda eval -m ollama/qwen3-coder:30b -s hard`, so open models
can be measured on the same tasks.

Output: a live line per tool call (and per model retry), a table (PASS/FAIL/ERR, steps, tokens, cost,
time, stop reason), totals, a mean per task for `--repeat`, and `report.json`. Exit code 0 when all pass,
2 otherwise.

`--keep-thinking off` (0.9) drops Claude's thinking blocks as Garuda did before 0.9, to measure the
change (default on, as in the product; `report.json` records `keepThinking`).

`--format on|off` (0.10, JS suites): both arms get a `biome.json` and the project formatted with Garuda's
own Biome first; `on` also formats after each edit (see [format.md](format.md)).

`--parallel n` (0.7) runs n tasks at the same time (a small pool; the results keep the task order).
`--batch on` (0.7, Anthropic models only) makes each task's model client the `AnthropicBatchClient`: every
model call is a batch of one at half price (each response carries `priceFactor: 0.5`), and the step waits
until the batch ends. It
sets `--parallel` to all tasks (up to 20) and the task time limit to 12 hours. The totals line adds the
share of tokens read from the prompt cache (batch caching is best effort), and the report the wall time;
`report.json` records `batch`, `parallel` and `wallMs`, and each result its `cacheReadTokens`.

Error runs: a run that throws (stop reason `error`, for example an API connection that broke even after
the loop's retries) says nothing about the agent. The report marks it `ERR`, leaves it out of the pass
count and the per-task means, and names the number in the totals line (`17/17 passed · 1 error run(s)
not counted`). Its tokens and cost still count in the totals. A task that runs longer than 10 minutes is
a failure with the stop reason `timeout`, not an error (12 hours with `--batch on`).

## Method

- Noise is large: one task can take 7 to 13 steps. Compare only with `--repeat 3` or more, on the same
  build, and change one thing per arm.
- Results so far (claude-sonnet-5, hard suite, 3 runs per task): code index off 50.0 steps / $0.194 (the
  default); lookup 53.2 / $0.242; all 51.2 / $0.232; bash hints 49.1 / $0.208 (no measured gain).
- Java and Python suites, first run (claude-haiku-4-5, one run each, before explore): java 5/5, 40 steps,
  $0.139; python 5/5, 31 steps, $0.120. Maven ran in the Seatbelt sandbox with no approval.
- Explore subagent (A/B, 0.3): no gain in steps or cost, so it is off by default. Details and the table:
  [agents.md](agents.md#evals).
- Todo tool (A/B, 0.4, claude-sonnet-5, hard suite, 3 runs per task, sums of means): off 18/18, 52.7
  steps, 330k tokens, $0.213; on 18/18, 54.7 steps, 359k, $0.230. The model never called `todo_write`,
  so the difference is noise plus the tool definition. It stays off by default.
- LSP diagnostics (0.4): `--lsp on` needs the OS sandbox and at least one server (`garuda lsp`); the
  run prints the server per language before the first model call, and the report JSON records the mode.
  A/B (claude-haiku-4-5, hard suite, 3 runs per task, sums of means): off 18/18, 79.6 steps, 532k tokens,
  $0.235; on 18/18, 85.8 steps, 582k, $0.234 (tsc 7.0.2 and pyright 1.1.414, managed, in Seatbelt). The
  servers ran: 55 edit results said "No errors", none listed an error, and no server failed. The model made
  no type errors in these tasks, so LSP had nothing to catch; the step difference is noise (one 29-step
  run). It stays off by default. A fair test needs tasks where type errors are likely.
- LSP for Java (0.4, jdtls 1.61.0, claude-haiku-4-5, java suite, 3 runs per task, sums of means): off 15/15,
  36.6 steps, 186k tokens, $0.130; on 15/15, 37.6 steps, 195k, $0.132; task times the same (13–31 s), so
  the warm start hid the Maven import. jdtls answered every edit in the Seatbelt sandbox (23 "No errors"
  results, no errors, no notices). Again no type errors to catch: no gain, no extra cost; off by default.
- The requirements doc keeps the per-task tables ("0.1 results", "0.2 results").

## Tests

`test/evals.test.ts`: every basic and hard task's check fails before the fix and passes with a reference
solution; the runner passes a solved task and reports steps, tokens and cost.

`test/evals.java.test.ts` and `test/evals.python.test.ts`: the same self-test for the Java and Python
tasks, run at the same time (`describe.concurrent`, 180 s limit each). They run only when the toolchain
probe passes; otherwise they are skipped, and the test name holds the hint. So on a machine without
Maven and JUnit in `~/.m2` (for example a cloud workspace with no access to Maven Central), `pnpm check`
still passes and says what is missing.
