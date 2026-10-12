# Budget review: reproduction baseline

Date: 12 October 2026. Scope: step 1 of the repair plan, before production changes.
Remote branch: `second-review-fixes`, fetched and verified at
`6c9f929d9f7ffac168e14be3bd80b30d39f0c205`.
Local investigation branch: `codex/budget-baseline`.
No applicable `AGENTS.md` was found in the checkout or its parent directories.

## Environment and executed checks

Local runtime: Linux container, Node v24.19.0, Vitest v5.0.1. Commands were invoked through
Corepack's repository-declared pnpm 10.28.0. The nested `pnpm` commands in `pnpm check` resolved
to the environment's pnpm 11.25.0; direct `pnpm exec` checks use the pinned entry point.
The existing installed root dependencies were reused. Site dependencies were installed from
the unchanged frozen lockfile.

| Check | Result |
| --- | --- |
| `corepack pnpm check`, before adding regression tests | Passed: typecheck, Biome and all 91 test files; 896 ordinary passes, 1 expected failure, 45 skips, 942 tests total |
| `corepack pnpm build` | Passed: CLI ESM and SEA-target CJS builds |
| `corepack pnpm build`, from `site/` | Passed: 45 pages; existing chunk-size, empty i18n and missing docs 404 warnings |
| Typecheck and Biome for the added regression code | Passed |
| New `test/budget-review.test.ts` | Five failing regression cases at the intended assertions; one passing control |

The original suite was run before any tracked changes. The new regression file contains
ordinary tests asserting the intended behaviour; it deliberately makes the full suite red
until the repairs are implemented. None of the five cases is marked as an expected failure.
The source under `src/`, package manifests, lockfiles and existing tests are unchanged.

This container does not provide the OS capabilities needed by all sandbox and local-socket
tests. The original suite's skips are not evidence that those behaviours work on macOS or
Linux hosts. This step did not rerun gitleaks, a separate control-character scan or remote CI.
The new provider scenarios use fake models or the real Anthropic SDK with every HTTP call
intercepted by an injected fetch. No live model requests or real credentials are used.

## Lifecycle map

| Boundary | Current behaviour | Consequence for the repair |
| --- | --- | --- |
| Turn entry: `src/loop/runAgent.ts` | A new root `TokenBudget` starts with `tokenBudget - budgetSpent(session)` | The shared budget is ephemeral; session records must retain expenditure for the next turn |
| Request sizing: `src/loop/budget.ts` | First request estimates system, messages and tools; later requests use the last reported context plus serialized subsequent messages; the caller adds its output limit | All routes must use a consistent, complete estimate |
| Attempt entry: `src/loop/callModel.ts` | `CallMeter.start()` reserves before `model.stream()` | A hidden provider attempt bypasses this boundary unless the adapter calls `meter.retry()` or disables SDK retries |
| Retry: `CallMeter.retry()` | The previous open reservation becomes spent; a new reservation must fit | An unreported attempt must not disappear when a later attempt succeeds |
| Adapter routes: `src/model/anthropic.ts`, `openaiCompatible.ts`, `deadline.ts` | Normal Anthropic streaming disables SDK retries under a meter; OpenAI-compatible HTTP retries and batch-to-normal fallback call `meter.retry()`; Anthropic batch creation retains SDK retry defaults | The generation-submission route is the remaining hidden-attempt gap |
| Settlement: `TokenBudget.settle()` | Reported usage replaces the reservation; unknown usage spends the whole reservation | Reservations settle once and propagate through the ancestor budgets |
| Unknown charge persistence: `TokenBudget.give()` | The root callback calls `addUnreported()` immediately and writes an `unreported` record | This path already survives next turns and parent resume |
| Child entry: `src/agents/child.ts` | The child gets a capped view of the parent's shared budget, respecting ancestor floors | The view tracks known usage live, but has no immediate persistence callback for reported child usage |
| Child reporting: `runChild()` and `src/tools/registry.ts` | Successful child usage returns in a report; non-abort failures carry a `SubagentFailure` report; aborts throw without it | Reported child usage can be lost before the parent sees the report |
| Tool-batch completion: `src/loop/toolRunner.ts` | Parallel calls use `Promise.all`; metadata is returned only if the batch completes | Returning a report on abort alone does not guarantee accounting for completed siblings |
| Parent aggregation: `runAgent()` | After the entire tool batch returns, tool metadata is journaled and child usage is added to parent totals | Moving persistence earlier requires exactly-once accounting; retaining this addition unchanged could double-charge |
| Parent replay: `src/session/resume.ts` | Assistant, compaction, tool-result child reports and unreported records rebuild totals; parent resume does not aggregate separate child journals | A child's own journal cannot repair a missing parent debit automatically |
| Tool output: `src/tools/registry.ts` | Successful rendered output is capped before after-hooks; error returns bypass that cap | The final result sent to the loop must be bounded on every return path |
| Parent floor: `runAgent.resultBound()` | Raw character caps divided by four are added to the floor | The estimate does not bound JSON escaping or all rendered child metadata |
| Compaction: `src/context/compact.ts` | Summary reservation uses the larger of prior context or serialized summary messages, plus 4,096 output tokens | The summary system prompt is missing when prior context does not cover it |

## Reproductions and observed values

| Case | Observation on the baseline | Intended assertion |
| --- | --- | --- |
| P1: batch SDK retry | A 300-token allowance and reservation permits two batch POSTs after a 503, succeeds, and settles to 30 tokens | One POST; failed reservation remains 300 tokens spent |
| P1: child cancellation | Shared budget spends 348; parent memory, journal replay and real `resumeSession()` retain 298 | All totals equal 348 |
| P1: resumed next turn, same case | A request one token over the real remainder starts; true lifetime expenditure reaches 10,001 against a 10,000 cap | No request; stop reason is `token_budget` |
| P2: plain child-result control | One child call, two parent calls; parent finishes; 5,220 tokens spent | Parent can answer within the cap |
| P2: escaped child result | One child call, only one parent call; parent stops with `token_budget`; 5,160 tokens spent | Preserve room for a final answer, including by refusing child work if necessary |
| P2: error-result cap | A 200,000-character thrown message produces a 200,020-character tool result | Complete result is at most 100,000 characters |
| P2: compaction request | Partial reservation is 4,134; complete estimate is 4,253; one request starts and spends 4,253 | Refuse the request before starting |

All five failing cases reached their intended assertions, not setup failures. On the baseline,
the plain-character case establishes that the fixture can complete useful parent/child work.
After repair, neither floor case requires a child to be admitted if a conservative bound makes
its request unaffordable; preserving the parent's final answer is the contract. The compaction fixture
first runs a roomy control to capture the exact summary request; its mocked input usage matches
the complete request estimate, so the failure does not depend on provider tokenization differences.
The cancellation fixture writes actual parent and child journals in a temporary directory and
resumes through the public `resumeSession()` function before testing the next turn.

Run the regressions from the repository root:

```sh
corepack pnpm exec vitest run test/budget-review.test.ts --reporter=verbose
corepack pnpm exec tsc --noEmit
corepack pnpm exec biome check test/budget-review.test.ts
```

## Boundaries for the next patches

1. Batch fix: disable hidden SDK retries for generation submission under a meter; polling is not
   another generation submission. Add a two-attempt positive control when implementing the repair.
2. Durable accounting fix: record reported child debits independently of tool-batch success,
   without duplicating the existing usage-report contribution. Check completed parallel siblings
   and older journal replay before choosing the journal format.
3. Result-bound fix: bound complete outcomes after formatting and hooks, including errors; account
   conservatively for serialization. Safe child refusal is permitted in either floor test; add a
   generous-budget child-work control when implementing the repair.
4. Compaction fix: estimate the whole summary request, keeping any deliberately conservative
   prior-context allowance. Cover automatic compaction and retries during implementation.

No repair or journal schema had been implemented at this baseline. Platform validation and
provider billing limits remain outside the evidence supplied by these mocked tests.

## Repair validation, 12 October 2026

The downloadable patch implements all four findings. It adds metered batch submission, immediate
`child_debit` persistence and report reconciliation, drainage of started parallel calls, complete
result caps in both registry and loop, a conservative serialized-result floor and complete
compaction sizing. The original five failures now pass as ordinary regression tests.

The final file contains 15 regression cases: both batch allowances, cancellation/resume/next-turn,
parallel cancellation with a late sibling, nested reports, partial-report reconciliation, legacy
journal replay, two small-budget floor cases, a generous-budget escaped-answer case, two final
hook/metadata caps, an error cap, a custom-runner cap and full compaction sizing. The cancellation
fixture now uses 100,000 tokens so that the more conservative floor admits the child and the test
still exercises cancellation. It asserts the known 50-token debit explicitly. Its saved, replayed
and restored totals now all equal 348, and the next request is refused. Nested debit records are
attributed to the direct child and total 90; the parent tree's full usage is 250, counted once.

Validation on this container:

- Full `corepack pnpm check`: 92 files passed, 911 ordinary passes, one expected failure and 45
  skips, 957 tests total. Typecheck and Biome passed.
- CLI ESM/CJS builds and the site build passed. The site retains the baseline build warnings.
- All 15 new cases pass without expected-failure annotations.
- A control-character scan of 365 tracked text files found none. Checksum-verified Gitleaks
  8.28.0 scanned the 16 reachable local commits and reported no leaks.

Material behaviour changes: the floor protects one next request using a worst-case JSON bound,
so small budgets may refuse child work earlier; complete subagent output now includes metadata
and hook feedback within the 20,000-character cap. A failed parallel batch waits for every started
call to settle before the turn ends. Pending reported debits protect the allowance after resume;
USD-cost breakdowns still depend on returned reports. Provider tokenization remains approximate.
No macOS host, live provider or remote CI validation is claimed by this patch.
