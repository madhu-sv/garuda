# Agent quality baseline: validation record (M0)

## Reference and environment

Original reference: `v0.17`, commit `2a56c6c02aafca33c78e4be72681dec582303710`.
Validation date: 2 October 2026. Local runtime: Node v26.9.0, macOS arm64, OS release 27.0.0.
Package manager: pnpm 10.28.0 from the repository declaration. The local Seatbelt launch probe passes
outside Codex's restricted sandbox. Linux/bubblewrap, Node 22 specifically and the SEA distribution
were not verified by this milestone; keep those platform claims limited.

## Executed checks

The working-checkout capture completed typechecking, Biome and the full Vitest suite on the approved
local host. The suite contains 71 test files and 697 tests: 684 ordinary passes, 12 expected failures
and one skip. The JSON reporter includes expected failures in its reported 696 passes; the M0
manifest separately labels the 12 reproduced open contracts. They are not successful safety tests.

Strict mode reran the twelve scenarios as ordinary tests. All twelve failed at the intended
assertions, not setup or tool errors. Component observations are described in `issue-register.md`.
The mail patch also applied successfully with `git am` to a clean clone of the original reference,
retaining the existing author identity. Its baseline capture outside OS temporary directories passed
typechecking, lint, all 684 ordinary tests and all twelve intended strict reproductions, with the same
one skip. Installed dependencies were reused from the working checkout; no installation was needed.
The targeted policy, portable polyglot and M0 suite also passes: 21 ordinary passes and 12 expected
failures. An attempted evidence-directory reuse is rejected before commands start, preserving the
original records.

One local test is intentionally skipped: `test/lsp.java.test.ts`,
`Java: the real jdtls (opt-in) (0.4) finds a type error in a Java file, and its fix`.
Its source requires an available OS sandbox and `GARUDA_TEST_JDTLS=1`. The opt-in was not enabled.
M0 does not install or exercise real jdtls. The normal fake language-server integration tests ran.

The restricted execution run retained an unsuccessful manifest: local-server binding errors,
unavailable nested Seatbelt and associated skips. It is useful environment evidence and is not
reported as a successful baseline. The generated polyglot fixture passed in both environments.

A first clean clone under `/tmp` reproduced a separate existing test-layout limitation:
`test/mcp.test.ts` creates its denied-write target beside the checkout, which is writable under the
sandbox's temporary-directory rule. That run failed one ordinary containment assertion and is
retained as unsuccessful evidence. The successful clean checkout was placed outside OS temporary
directories; M0 does not claim to fix that existing test's location assumption.

## Evidence storage and limitations

The capture creates local private logs, JSON reports and source/environment manifests in the selected
evidence directory, normally ignored `.garuda/evidence/quality-baseline/`. Regenerate these on the target checkout
with `pnpm baseline:capture --execution-context local-host`. Generated manifests bind evidence to the
actual commit, lockfile and source hashes rather than claiming portability from a single Mac run.
No live API calls, model-performance trials or dependency downloads were performed.

The twenty regression task IDs are selected and the forty-task capability plan is a draft. M0
neither implements all capability fixtures nor closes G01 to G09. P0 fixes and broader route coverage
belong to the next milestones. This record is a harness baseline, not a release safety certificate.

## G01 repair validation

The model-policy enforcement repair promotes G01 to an ordinary passing test and leaves eleven
open expected failures. Twenty additional fake-model integration cases exercise startup, direct
and CLI switching, aliases and numeric selections, resolver remapping, project policy loading,
session preservation and resumption, exploration, specialists and custom agents. Denied provider
factories receive zero invocations; allowed paths still make the expected fake-model requests.

The updated full suite contains 72 files and 717 tests: 705 ordinary passes, eleven expected
failures and the same one opt-in Java skip. The contract inventory now names both open and resolved
scenarios so capture can verify repaired assertions without dropping the remaining gap evidence.
The release safety gate remains blocked; M1 G02 to G04 and the subsequent milestones remain open.
