# Evals

Measure a model or a setting on eval tasks, also tasks from your repo's history.

## Evals

`garuda eval` runs eval tasks in scratch folders and reports pass or fail, steps, tokens and cost per task (N5).
A task passes when its check command exits with 0 and the agent did not change the task's tests.
The 0.1 target is 7 of 10.

```sh
garuda eval --list                         # the tasks of each suite
garuda eval -m claude-sonnet-5             # the basic suite (10 small repos)
garuda eval -s hard                        # the hard suite (6 tasks on a 110-file repo)
garuda eval -t fix-add hard-rename --keep  # some tasks, keep the scratch folders
garuda eval -s hard --repeat 3             # each task 3 times, with a mean row per task
garuda eval -s hard --repeat 3 --index lookup  # the same, with find_symbol and find_references (A/B)
garuda eval -s java                        # 5 Maven projects with JUnit 5
garuda eval -s python                      # 5 pytest projects
garuda eval -s hard --repeat 3 --subagents on   # A/B: the same, with the explore subagent
garuda eval --parallel 4                   # 4 tasks at the same time
garuda eval --batch on                     # A/B: model calls through the Batch API (half price, slow)
garuda eval -s hard --keep-thinking off    # A/B: drop Claude's thinking blocks, as before 0.9
garuda eval -s hard --format on            # A/B: Biome formats after each edit (and --format off)
garuda eval -s hard --repeat 3 --shuffle --seed 7  # repeats in a random order from seed 7
garuda eval --split heldout --repeat 3             # the held-out set (10 harder tasks)
```

The report (0.17) says how far one run's numbers can be trusted:

- the pass rate over all attempts with a 95% interval. Repeats of one task are not independent, so
  the interval comes from a cluster bootstrap over tasks; `--seed` (default 1) makes it repeatable;
- with `--repeat`, the tasks that passed every run and the ones that passed none;
- the median and p95 of steps, tokens and time;
- the cost per accepted change: the cost of all attempts, failures and error runs too, divided by
  the passes;
- unexpected changes: files that a run changed but the task did not need. They do not fail a task;
  a pass with extra edits is still a weaker result.

When the provider refuses the API key (401 or 403), or the API cannot be reached (a refused
connection, an unknown host, a certificate error), `garuda eval` stops after that run and says
so: every other run would fail the same way. Check `ANTHROPIC_API_KEY` (it wins over the stored
key) or run `garuda setup`. A report in which every run failed with an error says "No scored run"
and gives no rate: such a run measured nothing about the agent.

`report.json` (version 2) also holds Garuda's version and commit, the model and provider, the OS,
the seed and run order, and a hash of each task, so a later run can show that the tasks were the
same. With fewer than 10 tasks, or when every draw gives the same rate (all runs passed, or none),
the report says that the interval is only a rough guide.

Compare two runs of the same tasks, for example an A/B of a setting:

```sh
garuda eval -s hard --repeat 3 --shuffle --seed 7                      # arm A
garuda eval -s hard --repeat 3 --shuffle --seed 7 --keep-thinking off  # arm B
garuda eval compare .garuda/evals/<run-a> .garuda/evals/<run-b>
```

`compare` shows each task's passes in both arms, the difference of the pass rates (B − A, over all
attempts) with a paired 95% interval, the ratio of the cost per accepted change (B/A) with its own
paired interval, and each arm's cost per accepted change, unexpected changes and median time. It refuses two reports whose tasks differ (other task ids, or a task hash that
changed). A difference whose interval contains 0 is "no clear difference", never a win. Use the same
seed and `--repeat 3` or more in both arms.

### The held-out set (0.17)

The suites above are the dev split: use them to try changes. The held-out set is 10 harder tasks
in TypeScript, Python and Java, kept apart to measure a result once, at the end. A plain
`garuda eval` never runs it:

```sh
garuda eval --split heldout --repeat 3 --shuffle --seed 7   # only the held-out tasks
garuda eval --split heldout -t ho-ledger ho-export-dates    # some of them
garuda eval --split all                                      # every dev task and the held-out set
```

The tasks need more than one edit: the cause of a failure is in another file, a rename spans
modules, written tests must catch planted bugs, the repository's `AGENTS.md` sets conventions that a
hidden test checks, or the request is vague. Do not tune Garuda (or your `GARUDA.md`) on their
results: then they stop measuring. The Python tasks need pytest and the Java ones `--prepare java`.

### Claude Code as the baseline (0.17)

`--agent claude-code` runs Claude Code (`claude -p`) on the same tasks, with the same scratch
folders, prompt, time limit and grading. Only the agent differs:

```sh
garuda eval -s hard --repeat 3 --shuffle --seed 7 -m claude-sonnet-5-5                        # Garuda
garuda eval -s hard --repeat 3 --shuffle --seed 7 -m claude-sonnet-5-5 --agent claude-code    # baseline
garuda eval compare .garuda/evals/<garuda-run> .garuda/evals/<baseline-run>
```

- It needs the `claude` program on PATH, a Claude model, and an API key in `ANTHROPIC_API_KEY`
  (or one stored with `garuda setup`). A Claude subscription login is not used: the sandbox keeps
  the Keychain closed.
- Claude Code runs with every tool allowed (`bypassPermissions`), so Garuda runs it only in the OS
  sandbox: it writes only in the scratch folder and temp folders, and its network goes through
  Garuda's proxy to `api.anthropic.com` only. Without an OS sandbox the baseline is refused.
- Each run gets a new, empty config folder, so your own `CLAUDE.md`, settings, MCP servers, hooks
  and history do not change the result. The key reaches the process in its environment only.
- Its turn limit is `--max-steps` (default 50). Its tokens and cost come from Claude Code's own
  JSON result, which is saved as `<task>.claude.json` in the run folder.
- Options that change only Garuda (`--index`, `--subagents`, `--todo`, `--lsp`, `--keep-thinking`,
  `--format`, `--batch`, `--network`) are refused with the baseline, so the two arms differ in the
  agent only.

`--batch on` (0.7, Anthropic models) sends every model call as a batch of one: half the token price,
but each step waits until its batch ends (usually minutes). It runs all tasks at the same time (up to 20;
`--parallel` changes it) and gives each task 12 hours. The report shows the share of tokens from the
prompt cache and the wall time, to compare with `--batch off`.

The Java and Python suites need a toolchain. `garuda eval` checks it before the first model call and
says what is missing:

- Java: a JDK (17 or later), Maven, and JUnit 5 in `~/.m2`. Run `garuda eval --prepare java` once: it
  runs Maven on a small project with network, to download the plugins and JUnit. The evals then run
  offline.
- Python: `python3` with pytest 7 or later (`python3 -m pip install --user pytest`).
  `garuda eval --prepare python` checks it.

The checks guard against shortcuts: the tests and build files (`pom.xml`, `pyproject.toml`) are
protected, the Java check refuses a `.mvn` folder, and pytest reads only `pyproject.toml` and no
`conftest.py`.

### Benchmark your repo (0.12)

Measure Garuda on your own code. `--from-git` turns recent commits that changed code and tests into
tasks: the agent starts at the commit's parent, gets the commit message and the commit's tests, and
passes when the tests pass and it did not change them.

```sh
garuda eval --from-git                     # build .garuda/evals/repo-suite.json from the last 200 commits
garuda eval --from-git --since 2026-01-01 --max-tasks 10 --test-command "pnpm test"
garuda eval -s repo --list                 # the tasks
garuda eval -s repo -m claude-sonnet-5     # run them (the A/B flags work too)
```

A commit is kept only when its tests fail at the parent and pass at the commit. Garuda runs only the
commit's test files when it knows the runner; `--test-command "make test T={files}"` works for others.
Commits that change dependencies, binary files or more than 10 code files are skipped. Building runs your test command twice per
candidate on this machine, with no sandbox, in git worktrees: your checkout does not change.

The runner approves every call except its deny rules (`rm -rf`, `sudo`, `git push`, `curl`, `wget`).
Commands, and the check after each task, run in the scratch folders, in the OS sandbox when there is one (`--executor auto|os|host`). Results and session files go to
`.garuda/evals/<run-id>/`.

`pnpm startup` checks that startup takes less than 1 s (N3). The Anthropic SDK and the prompt library
load on first use, not at startup.
