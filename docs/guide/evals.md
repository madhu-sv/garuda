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
garuda eval -s medium                      # 10 harder tasks in TypeScript, Python and Java
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
- failures by kind (0.18.1): `check` (the check failed after the agent stopped), `protected-files`
  (the agent changed the task's tests), `step-limit`, `token-limit`, `repeated-calls`, `refusal`,
  `timeout`, `provider`, `sandbox`, `error`, and `setup` (the key, the connection or the MCP server). A limit
  or a timeout wins over the check that failed after it. Up to three runs of each kind are named.
  `provider` (0.18.2): the run hit its time limit while a model request was open, after a broken
  and retried stream or 2 minutes of silence from the API. That says nothing about the agent, so
  the run is not scored, and it runs once more by itself; the result keeps the spending of both.
  A command that runs until the limit is still the agent's `timeout`. `sandbox` (T15): the run
  failed after "needed" reads blocked a path in the home folder that a command read. A timeout now shows the
  steps up to the stop, not 0.

When the provider refuses the API key (401 or 403), or the API cannot be reached (a refused
connection, an unknown host, a certificate error), `garuda eval` stops after that run and says
so: every other run would fail the same way. Check `ANTHROPIC_API_KEY` (it wins over the stored
key) or run `garuda setup`. A report in which every run failed with an error says "No scored run"
and gives no rate: such a run measured nothing about the agent.

`report.json` (version 2) also holds Garuda's version and commit, the model and provider, the OS,
the seed and run order, and a hash of each task, so a later run can show that the tasks were the
same. Its `evidence.failures` lists each failed run with its kind, steps, tokens and time. The
reports of the 0.18 blog post are in
[docs/quality-baseline/evals/0.18](https://github.com/madhu-sv/garuda/tree/main/docs/quality-baseline/evals/0.18). With fewer than 10 tasks, or when every draw gives the same rate (all runs passed, or none),
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
garuda eval --split heldout --repeat 3 --shuffle --seed 7                  # only the held-out tasks
garuda eval --split heldout -t held-out-price-cache held-out-slow-search  # some of them
garuda eval --split all                                                   # every dev task and the held-out set
```

Each task has a trap: a quick fix that passes the visible tests but not the hidden test that the
check adds after the run. The cause is in another file than the symptom, a refactor must keep the
output to the space, written tests must catch subtle planted bugs, the repository's `AGENTS.md`
sets rules (for example: never show whether an account exists), or the request is vague ("search
is slow") and the fix must keep every result. Do not tune Garuda (or your `GARUDA.md`) on their
results: then they stop measuring. The Python tasks need pytest and the Java one `--prepare java`.

From a source checkout, run `pnpm build` after you apply a change: `garuda eval` runs the build
in `dist/`, and it warns when that build is older than the checkout.

### Tune a prompt addendum (0.17)

`garuda eval tune` improves a short text that Garuda adds to its system prompt, the addendum. A
proposer model (default Claude Opus 5.5) reads where the agent failed, or what each task cost when
all passed, and writes a new version; Garuda scores it on the dev suites with the same seed.

```sh
garuda eval tune --addendum my-addendum.md -m claude-haiku-5-5 --rounds 5 --max-cost 20
```

- A version stays when no task goes from all runs passing to none, and it passes at least 2 more
  runs (`--margin`), or as many runs at a clearly lower cost per accepted change (the 95% interval
  of the cost ratio below ×1.0). The next proposal starts from the version that stayed.
- A text that asks the agent to skip or edit tests or checks, or to leave the sandbox, is refused
  before it costs a run. The proposer never sees the held-out tasks.
- At the end, if a version stayed, the held-out set runs twice (no addendum, then the final one),
  5 runs a task. That comparison is the only number to quote.
- A refused text gets one more try in the same round. A rule that forbids a shortcut ("never
  modify tests") is not refused.
- Before the first run the command shows the plan and asks (`--yes` skips the question). It stops
  before a round that would pass `--max-cost`. `--parallel <n>` (default 4) runs that many runs at
  a time, with a line per run.
- The first run (Haiku 5.5, Opus 5.5 proposing, $0.65): the kept version cut the held-out cost per
  accepted change to ×0.81 (95% interval ×0.75 to ×0.88), with every run passing in both arms.
- Garuda never edits your file. The results go to `.garuda/evals/tune-<id>/`; to use the final
  text, copy `final.md` into `GARUDA.md` yourself. `garuda eval --addendum <file>` runs any suite
  with an addendum, for a check of your own.

### One MCP server: an A/B (0.17)

Evals run without your MCP servers, so your setup does not change the results. `--mcp <server>`
allows one server from your own `~/.garuda/mcp.json` (not a project's), to measure what it adds.
`--mcp-prepare <command>` runs in each scratch folder before the agent starts, in the sandbox with
no network; what it writes does not count as a change of the agent.

For [Graphify](https://pypi.org/project/graphifyy/), a code knowledge graph, install it with
pipx (`brew install pipx`, then `pipx install "graphifyy[mcp]"`; it needs Python 3.10 or later)
and add its server to `~/.garuda/mcp.json`. `"servers"` is an object, one key per server:

```json
{ "servers": {
  "graphify": { "command": "/Users/you/.local/bin/graphify-mcp", "args": ["graphify-out/graph.json"] }
} }
```

(`which graphify-mcp` gives the path.) The prepare command builds the graph, and can also write
the note that tells the agent about it, as a user would in `GARUDA.md`: the agent reads it at the
start of the run. Without a note, the agent may never call the server.

```sh
NOTE='This project has a code knowledge graph (graphify-out/). Use the graphify tools (query_graph, get_neighbors, shortest_path) to find code before you search files.'
garuda eval -s hard --repeat 3 --shuffle --seed 7                               # arm A
garuda eval -s hard --repeat 3 --shuffle --seed 7 \
  --mcp graphify --mcp-prepare "graphify update . && echo '$NOTE' >> GARUDA.md"  # arm B
garuda eval compare .garuda/evals/<arm-a> .garuda/evals/<arm-b>
```

`graphify update .` builds the graph with tree-sitter: no model and no API key. A graph helps in a
large repository; on a task of a few files the agent reads them all, so use the hard suite (about
110 files) or your repo suite (`-s repo`). Arm A gets no note: the A/B measures the server and the
note together, as a user would set them up. The report gives the MCP tool calls; when the agent
never used the server, the A/B measured nothing. A server that does not start, or a prepare
command that fails, stops the eval at the first run.

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

### Which model for this repo: `garuda advise` (0.18.1)

```sh
garuda eval --from-git          # once: the repo suite from your history
garuda advise                   # Haiku 5.5 and Sonnet 5.5, 2 runs a task, at most $2
garuda advise --models claude-sonnet-5-5,claude-opus-5-5 --repeat 3 --max-cost 10
```

It shows the plan and a cost guess and asks first. Then it runs the suite on each model, compares
them as `eval compare` does, and advises: the model that passes clearly more; with no clear
difference in passes, the one that costs clearly less per accepted change. With fewer than 10
tasks the advice says it is a rough guide. The reports, `advice.txt` and `report.html` are in
`.garuda/evals/advise-<id>/`.

Since 0.18.2:

- **4 runs at a time.** Change it with `--parallel <n>`. Each result line starts with the model and
  a count: `[haiku-5-5 12/30] ✓ fix-parser: pass`.
- **Earlier runs are reused.** A run with the same model, task hashes, `--repeat`, `--seed` and
  Garuda version and build, with every run there, is not run again. `advise` prints
  `Reusing <folder>`. Runs of 0.18.0 and before are never reused.
- **A better estimate.** It comes from earlier runs of the model on the same tasks. Else it prices
  each request of the other model's runs at this model's prices; a run with a subagent cannot be
  priced again and is left out. When both models ran other repo tasks before, that price is
  scaled by how their real costs compared there (Sonnet 5.5 needs about half the tokens of
  Haiku 5.5). Else it is a token guess. The plan says which.
- **A command to go on.** When the estimate, or the first model's real cost, passes `--max-cost`,
  `advise` prints the command to run next, with a higher cap. The first model's run is reused.

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
candidate on this machine, with no sandbox, in git worktrees: your checkout does not change. Since
0.18.2 a kept commit runs its tests a third time, as an eval runs them: in a copy of the commit, in
the sandbox. A commit whose tests fail there is left out, because no model could pass it. For
example, a test that starts its own sandbox fails like this on macOS. The output shows the first
such failure. In an eval, commands may write Vite's and other caches in your `node_modules`
(`.vite-temp`, `.vite` and `.cache`), and nothing else there.
Built a suite before 0.18.2? Build it again: in one user's suite, 12 of 30 tasks could not pass.

The runner approves every call except its deny rules (`rm -rf`, `sudo`, `git push`, `curl`, `wget`).
Commands, and the check after each task, run in the scratch folders, in the OS sandbox when there is one (`--executor auto|os|host`). Results and session files go to
`.garuda/evals/<run-id>/`.

`pnpm startup` checks that startup takes less than 1 s (N3). The Anthropic SDK and the prompt library
load on first use, not at startup.
