# The eval reports of 0.18

These are the `report.json` files of the runs in the blog post
[Garuda against Claude Code, with intervals](https://madhu-sv.github.io/garuda/blog/evals-with-evidence/).
Each run is one folder. Every number in the post comes from these files.

## The runs

| Folder | Post section | Model | Runs | Seed | Original run |
| --- | --- | --- | --- | --- | --- |
| `heldout-haiku-garuda` | Garuda and Claude Code (A) | Haiku 5.5 | 10 tasks × 3 | 7 | 20261030-150911-b9c9 |
| `heldout-haiku-claude-code` | Garuda and Claude Code (B): Claude Code 2.1.312 | Haiku 5.5 | 10 × 3 | 7 | 20261030-152013-b3e5 |
| `hard-haiku-without-graphify` | A code graph (A) | Haiku 5.5 | 6 × 3 | 7 | 20261030-182731-e3ca |
| `hard-haiku-with-graphify` | A code graph (B): `--mcp graphify` | Haiku 5.5 | 6 × 3 | 7 | 20261030-183120-6398 |
| `tune-haiku/` | A tuned prompt: the `garuda eval tune` run | Haiku 5.5 | see below | 1 | tune-20261103-104958-be20 |
| `heldout-sonnet-without-addendum` | A tuned prompt (A, Sonnet) | Sonnet 5.5 | 10 × 3 | 7 | 20261103-164238-5844 |
| `heldout-sonnet-tuned-addendum` | Tuned text, Sonnet | Sonnet 5.5 | 10 × 3 | 7 | 20261103-164523-2b32 |
| `heldout-haiku-0.18-prompt` | Shipped rewrite, Haiku | Haiku 5.5 | 10 × 3 | 7 | 20261104-174730-7cb2 |
| `heldout-sonnet-0.18-prompt` | Shipped rewrite, Sonnet | Sonnet 5.5 | 10 × 3 | 7 | 20261104-174755-ad1a |

`tune-haiku/` holds the whole tune run:

- `v0/` and `v2/`: the dev scores (26 tasks × 3) of the empty addendum and of the kept version;
- `heldout-empty/` and `heldout-final/`: the held-out set (10 tasks × 5) without and with it;
- `v1.md`, `v2.md`, `v3.md`: each proposal; `v1.input.md` … `v3.input.md`: what the proposer saw;
- `history.json`: each round's reason, decision and cost; `final.md`: the kept text;
- `heldout.txt`: the comparison that the tune command printed at the end.

All runs ran on macOS (arm64) with the OS sandbox. The reports say `garuda.version` 0.17.0: they ran
on branches before the version changed to 0.18.0. Those branches were squash-merged, so their
commits are not in `main`. The task hashes in each report are the check: every hash here matches
the tasks of 0.18.0.

## Check the numbers

From a clone of the repository (`pnpm install && pnpm build`):

```sh
R=docs/quality-baseline/evals/0.18
garuda eval compare $R/heldout-haiku-garuda $R/heldout-haiku-claude-code              # ×1.75 (×1.54 to ×2.06)
garuda eval compare $R/hard-haiku-without-graphify $R/hard-haiku-with-graphify        # ×1.28 (×1.19 to ×1.38)
garuda eval compare $R/tune-haiku/heldout-empty $R/tune-haiku/heldout-final           # ×0.81 (×0.75 to ×0.88)
garuda eval compare $R/heldout-sonnet-without-addendum $R/heldout-sonnet-tuned-addendum  # ×0.87 (×0.79 to ×0.95)
garuda eval compare $R/heldout-sonnet-without-addendum $R/heldout-sonnet-0.18-prompt  # ×0.90 (×0.84 to ×0.96)
garuda eval compare $R/heldout-haiku-garuda $R/heldout-haiku-0.18-prompt              # ×0.88 (×0.79 to ×1.02)
```

`test/publishedEvals.test.ts` runs these six comparisons and checks the numbers.

## The failures

Two runs failed, both on the refund trap (`held-out-invoice-split`, run 1): Claude Code, and Garuda
with the 0.18 prompt on Haiku. Both stopped normally (`done`), and the hidden test failed. In the
failure kinds that `garuda eval` reports from 0.18.1, both are `check`. Every other run passed. The
reports predate the `evidence.failures` field, but each failed result keeps its full `reason`.

## What was changed, and what is not here

The reports are as Garuda wrote them, with two changes to strings only:

- the checkout path at the start of `sessionFile` is removed, so the path is relative to the
  checkout (`.garuda/evals/<run>/<task>.jsonl`);
- the macOS temp folder in failure reasons is `<tmp>/`.

The session files (`.jsonl`, and `.claude.json` for Claude Code) are not here. They hold the
model's whole conversation and the system prompt, and are much larger. Ask in an issue if you need
one.
