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
(Later: G03 was fixed in the merge gate, and G02, G04 and G06 after it. See below.)

## Merge gate validation (0.14.0-dev)

The merge gate adds seven commits on `model-policy-enforcement` (`39a7158`): policy limits copy the
settings; an open gap counts only when its intended assertion fails; the team policy comes from the
managed file and `~/.garuda` (G03 resolved); a redacted, hash-chained audit log under `~/.garuda/audit`
(two G07 scenarios resolved); hunk approval writes only the accepted hunks (U0, tested on the file on
disk); daemons and MoE are opt-in and `delegate_expert` runs alone (G05 resolved); project language
plugins are not loaded and tests use the built-in experts (G09 mitigated, still open); and this
version and documentation correction.

Run on Linux (Node v22.22.2), `pnpm check`: 73 test files, 739 tests: 726 passed, 7 expected
failures (the open gaps G02, G04, G06, G07 child outcome, G08 twice, G09) and 6 skipped (macOS-only
Seatbelt tests and the opt-in Java test). A CLI smoke test checked the policy notice for a project
`policy.json`, the policy refusal, the eval refusal and a broken policy file. Not run here: macOS
Seatbelt, a live model, and the hunk review in a real terminal. Run `pnpm check` on the Mac after
`git am` and try one hunk review by hand before the merge.

## G02, G04 and G06 (after the merge gate)

Three fixes on top of the merge gate: the policy's blocked hosts come before the project's
allowlist in the proxy (G02); grep, glob and the code index skip files that `denyPaths` denies (G04);
a child's wrap-up call runs only when it fits in its token budget (G06). The three gap tests are
ordinary tests, and `test/policyGaps.test.ts` adds positive controls. Run on Linux (Node v22.22.2),
`pnpm check`: 74 test files, 745 tests: 735 passed, 4 expected failures and 6 skipped. Open: G07 child outcome, G08 (two), G09.

## Garuda's own review and release (0.14.0)

Garuda reviewed its own code with Fable 5.1 in plan mode, one area per run, with the docs and the
known-gap tests left out of the copy (`garuda-live/review/run-review.sh`). Each finding was checked
in the code before a fix, and each fix has a test that fails without it. Patches 0128–0141 fix the
redactor and resume, project settings consent, symlinks and case in paths, the search setting,
thinking summaries and the stream idle timeout, provider keys out of the environment, UTF-8 edits,
MCP consent text, the hang on a background child, the sandbox process space (Linux) and app launch
(macOS), the open tool call after Ctrl-C, the policy limits for subagents, `@path` checks, and the
audit log (G07 resolved, hooks recorded and under the policy).

Run on Linux (Node v22.22.2), `pnpm check`: 77 test files, 804 tests: 797 passed, 1 expected failure
(G09) and 6 skipped (macOS-only Seatbelt tests and the opt-in Java test). Live on macOS (Seatbelt,
2026-10-03): `open -a Calculator` and `osascript` Apple events are refused in the sandbox (error -54,
-600) and work in a normal terminal (the control run); ordinary commands (`git status`, `node -e`) run as before. The known
limits of 0.14.0 are listed in the README under the status table.

## Release 0.14.1

Garuda's review of the cli and extensions areas (Fable 5.1, plan mode), and fixes for the open
findings of all nine areas (patches 0149–0152). Patch 0153 adds the npm package and the Homebrew
formula. Before the release, the parallel eval test failed now and then on macOS and Linux: one
task's check ended with SIGKILL and no output. The cause was one sandbox executor for all runtimes
of the process; a task that ended called `shutdown()` and killed the commands of the others. Each
runtime now gets its own executor; the new test fails without the fix, and the parallel eval test
passed 25 runs in a row with it (it failed at runs 3 and 6 without it).

Run on Linux (Node v22.22.2), `pnpm check`: 81 test files, 837 tests: 830 passed, 1 expected
failure (G09) and 6 skipped. The known limits of 0.14.1 are listed in the README under the status
table.

## Editors over ACP and release 0.15.0

Patches 0159–0163 on the `acp` branch: the design, the call id in approval questions, `garuda acp`
and its docs. `pnpm check` on Linux (Node v22.22.2): 83 test files, 859 tests: 852 passed, 1
expected failure (G09) and 6 skipped. Each rule of the adapter has a test that fails without it
(negative controls run by hand: call id, visible characters, the diff, the stdout guard, cancel
during a question and during a command, one prompt at a time, plan mode, deny on a cancelled
answer).

Process test (Linux): `node dist/cli/index.js acp`, driven over stdio, wrote only JSON-RPC lines on
stdout and exited with 0 when stdin closed.

Live test (2026-10-06, macOS, VS Code with the ACP Client extension, Claude Sonnet 5): a question
about the project, an edit after "Allow once", a command outside the sandbox that was denied, stop
during `sleep 60`, and Plan mode all behaved as designed. The same five steps in Zed 1.22, checked
in Zed's ACP log, behaved as designed too; the one finding (a stopped command showed as done) is
fixed in 0164. Details in [acp.md](../lld/acp.md#tests).

Release 0.15.0 (patches 0159–0166): `pnpm check` on Linux (Node v22.22.2): 83 test files, 862
tests: 855 passed, 1 expected failure (G09) and 6 skipped. After 0164 and 0165 (a stop names what
it ended; running calls settle), the stop in the live test showed `Garuda: $ sleep 60 cancelled.`

## Setup and the editor sign-in, release 0.16.0

Patches 0167–0172 on the `setup-design` branch: the design ([setup.md](../lld/setup.md)), stored
keys in `~/.garuda/credentials` with the sandbox rule and the default model, `garuda setup`, ACP
Terminal Auth in `garuda acp`, the docs and the release. `pnpm check` on Linux (Node v22.22.2): 86
test files, 899 tests: 892 passed, 1 expected failure (G09) and 6 skipped. On macOS, the real
Seatbelt sandbox could not read `~/.garuda/credentials`. Each rule's test was checked against a
negative control (the test fails without the rule).

Live tests on macOS (2026-10-06): `garuda setup` in a terminal with a temporary home (key check at
Anthropic, file mode 0600, masked summary); Zed 1.22 with an agent entry that gave no model and no
key: the sign-in ran `garuda acp setup` in a terminal, and the next thread worked with no restart.

Release 0.16.1 (patches 0174–0175): the ACP Registry's auth check (`verify_agents.py --auth-check`,
run on macOS against 0.16.0 from npm) failed with "No authMethods in response": its checker declares
Terminal Auth only as `_meta["terminal-auth"]`. 0174 accepts that form. `pnpm check` on Linux (Node
v22.22.2): 86 test files, 901 tests: 894 passed, 1 expected failure (G09) and 6 skipped. Over stdio
with the checker's capabilities, `initialize` returned the `garuda-setup` method.
