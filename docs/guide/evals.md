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
```

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
