# Agent quality baseline (M0)

M0 establishes evidence for the roadmap, not fixes for the runtime controls. The original baseline is
`v0.17` at `2a56c6c02aafca33c78e4be72681dec582303710`. On 2 October 2026 its unrestricted
macOS checks passed: 70 test files, 684 passed tests and one skipped. The restricted run could not
bind several local test servers and gave different results; those are environment failures, not a
coding-quality comparison. No paid model evaluation was run.

## Capture a baseline

Use Node >=22 and the locked pnpm version with dependencies already installed. From a clean checkout:

Keep the checkout outside OS temporary directories. The existing MCP sandbox test creates its
denied-write target beside the checkout; a checkout under `/tmp` makes that target writable by
design and fails the containment assertion. This test-layout limitation is recorded in the evidence.

```sh
pnpm baseline:capture --execution-context local-host
```

The script runs typechecking, lint, the full harness suite and the strict open-contract suite. It
writes timestamped evidence under ignored `.garuda/evidence/quality-baseline/`: a manifest, runner reports and
command logs. `--output /absolute/new/directory` selects another evidence directory. It performs no
installs or live model calls and never captures environment variable values or credentials. Keep raw
reports private: future tests may include sensitive output. The manifest records commit, branch,
tracked diff hash, source hashes, lockfile hash, runtime, platform, fake-model configuration, executor
launch probe, commands, results and every runner-reported skip. An executor launch probe is not a
containment guarantee. A missing skip reason is recorded as an evidence gap, not guessed.

A successful capture exits zero only when ordinary checks pass AND all named open-contract
reproductions fail at their intended assertions. It still declares the release safety gate blocked.
Unexpected runtime errors, missing reports, changed scenarios or a fixed contract invalidate the
capture. Logs and JSON reports retain the exact assertions for review. Resolve discrepancies before
accepting a baseline; never relabel missing prerequisites as passes.

## Open contracts are not passes

`test/known-agent-gaps.test.ts` contains twelve desired-behaviour assertions for G01 to G09.
G01 now runs as an ordinary passing test after the model-policy repair. The remaining eleven use
`it.fails` so tracked defects do not make unrelated harness development impossible.
Vitest can count expected failures in its reported pass total; that number must not be cited as
successful safety coverage. The baseline script separately reruns them in strict mode and identifies
the eleven remaining assertions as open and G01 as resolved. Run that suite directly:

```sh
GARUDA_GAP_REPRO_STRICT=1 pnpm exec vitest run test/known-agent-gaps.test.ts
```

Exit 1 is expected on this baseline. As each contract is fixed, convert its registration from
`knownGap` to ordinary `it`, move its title from `scenarios` to `resolvedScenarios` in
`known-gap-contracts.json`, remove its failure pattern, and update the issue evidence. The capture
requires both the named open reproductions and the named repaired contracts to match their status.
The normal suite will flag an unexpectedly passing contract. Do not weaken the desired assertion to
preserve an expected failure. If a different error causes it to fail, the reproduction is not valid,
and the normal suite now says so too: `knownGap` counts a failure as expected only when it is an
`AssertionError` whose message contains the scenario's `failurePatterns` text. Any other error (a
TypeError after a rename, a setup failure, another assertion) makes `pnpm check` fail. Before this
change, `it.fails` accepted any thrown error, so only the strict run could see such a regression.

All probes use fake models, synthetic canary values and temporary roots that are removed afterwards.
No real blocked host is contacted, and no destructive command is executed. A test-only component
seam exercises the private proxy decision method for G02 (now fixed); it deliberately does not
claim HTTP end-to-end coverage. The concurrency test delays a controlled temporary-file mutation to make the
scheduling overlap observable without risking application files.

## Portable polyglot fixture

`test/knowledge.plugins.test.ts` now generates TS, Python, Java, Go and Rust source files in a temporary
repository. It retains the five-language, symbol and affected-test assertions. It does not depend on
a local `garuda-polyglot` checkout and no longer silently returns when that unrelated repository
is absent. Parsing checks need no external compiler, LLM or installation.

## Milestone artefacts

- [Issue register](issue-register.md): desired and observed behaviour, reproductions, scope and follow-ups.
- [Open contract titles](known-gap-contracts.json): versioned strict-evidence inventory.
- [Evaluation selection](evaluations/evaluation-plan.json): twenty existing regression tasks and capability draft.
- [Evaluation protocol](evaluations/README.md): graders, traces, execution and release interpretation.
- [Recorded evidence](validation-record.md): actual validation and remaining platform limits.

M0 acceptance requires a repeatable clean-checkout check, verified strict assertions, named skips,
portable fixtures and frozen initial evaluation definitions. M1 to M4 must close the open controls
before a safety release gate can pass. Paid trials and the larger capability suite remain subsequent
work; this milestone does not claim improved model performance.
