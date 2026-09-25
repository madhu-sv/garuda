# Evals (`src/evals/`, `src/cli/evalCommand.ts`)

## Purpose

Measure the agent on fixed tasks (N5): pass rate, steps, tokens, cost and time. Compare changes with
same-build A/B runs.

## Parts

| File | Role |
| --- | --- |
| `types.ts` | `EvalTask` (id, title, prompt, files, check command, protected files, reference solution) and `EvalResult`. |
| `tasks.ts` | Basic suite: 10 small tasks (fix a failing test, off-by-one, rename, implement, missing await, CSV quotes, write tests, config default, new module, extract helper). |
| `shopkit.ts` | A generated repository of about 107 files (entities, services, API) for the hard suite. |
| `hardTasks.ts` | Hard suite: 6 tasks on shopkit (rounding, event, import, rename across files, unused code, coupon). |
| `suites.ts` | `basic`, `hard`, `all`. |
| `runner.ts` | Runs tasks; `formatReport`. |

## Runner

For each task (and each repeat):

1. Create a scratch folder in the temp directory; write the task files.
2. Snapshot the protected files (default: everything under `test/`).
3. `Runtime.create` with an `AutoApprover("once")`, deny rules (`rm -rf*`, `sudo*`, `git push*`, `curl*`,
   `wget*`), `mcp: false`, `hooks: false`, `web.enabled: false`, and the chosen executor and code index mode.
4. `runTurn(prompt)` with a 10-minute limit.
5. Pass when the protected files are unchanged and the check command (for example `node --test`) exits 0.
   The check runs on the host with a 120 s limit.
6. Copy the session file to `.garuda/evals/<run-id>/<task>.jsonl` (`-2`, `-3` … for repeats).

## Command

```text
garuda eval [-m model] [-s basic|hard|all] [-t ids…] [--repeat n] [--index off|lookup|all]
            [--executor auto|os|host] [--max-steps n] [--keep] [--list]
```

Output: a live line per tool call, a table (PASS/FAIL, steps, tokens, cost, time, stop reason), totals,
a mean per task for `--repeat`, and `report.json`. Exit code 0 when all pass, 2 otherwise.

## Method

- Noise is large: one task can take 7 to 13 steps. Compare only with `--repeat 3` or more, on the same
  build, and change one thing per arm.
- Results so far (claude-sonnet-5, hard suite, 3 runs per task): code index off 50.0 steps / $0.194 (the
  default); lookup 53.2 / $0.242; all 51.2 / $0.232; bash hints 49.1 / $0.208 (no measured gain).
- The requirements doc keeps the per-task tables ("0.1 results", "0.2 results").

## Tests

`test/evals.test.ts`: every task's check fails before the fix and passes with a reference solution; the
runner passes a solved task and reports steps, tokens and cost.
