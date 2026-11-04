---
title: "Garuda against Claude Code, with intervals"
description: "Repeated runs, a held-out set with traps, and paired intervals. Garuda and Claude Code pass the same tasks; Claude Code costs 1.75 times as much per accepted change. Plus what a code graph and a tuned prompt did."
date: 2026-11-04
author: Madhusudhan Vasanth Kumar
---

Garuda had an eval command from its first release, but it gave one run per task and one number.
That is enough to catch a regression. It is not enough to say "Garuda is cheaper than X" or "this
change helps". For 0.18 I rebuilt the evals so that a claim comes with an interval, and then I
tested Garuda against Claude Code, a code-graph MCP server and a tuned prompt.

## The method

- **Repeated runs.** Each task runs 3 or 5 times, in a shuffled order from a seed, so a slow period
  of the API does not hit one task only.
- **A held-out set with traps.** Ten tasks in TypeScript, Python and Java that no tuning ever sees.
  Each has a quick fix that passes the visible tests but fails a hidden one: a cache key without
  the currency, a new idempotency key on each retry, a refund that splits the wrong way, a
  migration that edits an old file. Hidden tests and mutation checks run after the agent stops.
- **Intervals.** The pass rate gets a 95% interval from a bootstrap over tasks, not over runs,
  because the repeats of one task are not independent.
- **Paired comparisons.** `garuda eval compare` takes two reports of the same tasks (it checks a
  hash of each task) and gives B − A for the pass rate and B / A for the cost, each with a paired
  interval. A difference whose interval contains 0 (or ×1.0) is "no clear difference", never a win.
- **Cost per accepted change.** The cost of all attempts, failures included, divided by the passes.
- **Unexpected changes.** Files that a run changed but the task did not need. They do not fail the
  task; they are counted.

## Garuda and Claude Code

`--agent claude-code` runs Claude Code (`claude -p`) on the same tasks, in the same scratch folders,
with the same time limit and grading. It runs with every tool allowed, so only inside Garuda's OS
sandbox, with a new config folder per run and network only to `api.anthropic.com`. Both agents used
Claude Haiku 5.5, 3 runs per held-out task, seed 7.

| | Garuda | Claude Code 2.1.312 |
| --- | --- | --- |
| Passed | 30 of 30 | 29 of 30 |
| Cost per accepted change | $0.0034 | $0.0059 |
| Median time | 19 s | 25 s |
| Unexpected changes | 0 | 0 |

The pass rates show no clear difference: −3 points, interval −10 to 0. Claude Code's one failure
was the refund trap. The cost shows a clear one: Claude Code cost **×1.75** per accepted change
(95% interval ×1.54 to ×2.06). Its median run used about 144k tokens, against 46k for Garuda.

## My own tasks had bugs

The first live runs failed for reasons that were mine, not the agent's. Each one showed up when I
read a failed run in full:

- A task failed 0 of 3 because the agent, with the right fix, added a CSV test to a protected test
  file. A careful engineer does that. The visible tests are no longer protected where a hidden
  test decides.
- A hidden test read a field called `dueDate`, but the prompt never named it, and the agent chose
  `dueAt`, which matched the repository's `created_at`. A hidden test may now check only what the
  prompt or the repository decides.
- A failed check gave an empty reason: a guard stopped it with no output. Guards now say what is
  missing.
- Two runs used an old build, and the report named the checkout's commit. The build now records
  its own commit, and an eval warns when the checkout is newer.

An eval is code. It needs the same care as the code it measures.

## A code graph

I tested [Graphify](https://pypi.org/project/graphifyy/), a code knowledge graph over MCP, with
`--mcp graphify --mcp-prepare "graphify update ."`. With a note in `GARUDA.md`, the agent used it in
14 of 18 runs on the hard suite (6 tasks, about 110 files). Every run passed with and without it,
and it cost **×1.28** per accepted change (×1.19 to ×1.38). The agent already finds code with grep,
and the graph's tools and results add tokens to every request. A graph may pay off in a much larger
repository. Garuda does not include it; the docs show how to add it and how to measure it.

## A tuned prompt

`garuda eval tune` lets a frontier model (Opus 5.5) propose a short addendum to the system prompt.
A version stays only if no task goes from all runs to none and it passes more runs, or as many runs
at a clearly lower cost. The held-out set is measured once, at the end, and the proposer never
sees it. The first run cost $0.65. The kept version says, in short: batch tool calls that do not
depend on each other, read only what the edit needs, verify once, stop when done.

| Held-out set, all runs passing | Cost per accepted change |
| --- | --- |
| Tuned text, Haiku 5.5 (5 runs a task) | ×0.81 (×0.75 to ×0.88) |
| Tuned text, Sonnet 5.5 (3 runs a task) | ×0.87 (×0.79 to ×0.95) |
| Shipped rewrite, Sonnet 5.5 | ×0.90 (×0.84 to ×0.96) |
| Shipped rewrite, Haiku 5.5 (one refund miss) | ×0.88 (×0.79 to ×1.02) |

I removed two rules that served the evals, not users ("do not call `remember`", "a one-sentence
answer") and rewrote the rest in Garuda's style. The rewrite is in 0.18's system prompt. With
Haiku its saving is likely but not shown with confidence.

## The limits

- The tasks are small and I wrote them. Current models pass nearly all of them, so pass rates do not
  yet tell two agents apart; the cost does.
- One model family, and Claude Code in one configuration (print mode, every tool allowed, no user
  settings). Costs are list prices from each run's token counts.
- Ten held-out tasks give wide intervals. More tasks, and a larger real repository, are next.

## Run it yourself

```sh
npm install -g @garuda-agent/garuda
garuda eval --split heldout --repeat 3 --shuffle --seed 7 -m claude-haiku-5-5
garuda eval --split heldout --repeat 3 --shuffle --seed 7 -m claude-haiku-5-5 --agent claude-code
garuda eval compare .garuda/evals/<garuda-run> .garuda/evals/<claude-code-run>
```

The method is in the [evals guide](/garuda/docs/guide/evals/). The `report.json` of every run in
this post is in the repository, under
[docs/quality-baseline/evals/0.18](https://github.com/madhu-sv/garuda/tree/main/docs/quality-baseline/evals/0.18),
with the seeds, the task hashes, each run's result and the `compare` commands that give the
numbers above. If your numbers differ from mine, I want to know.
