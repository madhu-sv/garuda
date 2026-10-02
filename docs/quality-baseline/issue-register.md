# Known agent gaps: issue register (M0)

Original M0 status: all nine issue groups were open, with twelve intended strict failures.
Current repair status: G01, G03, G05 and two of the three G07 scenarios are resolved; G02, G04, G06,
the G07 child outcome, G08 and G09 remain open, with seven intended strict failures (merge gate,
2026-10-02).
This is component evidence, not a complete adversarial
security audit. Expectations are acceptance contracts proposed in the roadmap; their failure does
not imply the earlier v0.17 requirements already promised every stronger guarantee.

Run `GARUDA_GAP_REPRO_STRICT=1 pnpm exec vitest run test/known-agent-gaps.test.ts -t G01` (substitute the issue ID).
Use the normal `test/policy.test.ts` and the full suite as positive controls. The fixed issues must
ultimately reject prohibited effects while retaining allowed neighbouring operations.

## G01 Model policy on switching

Priority P0, milestone M1, owner runtime maintainer. Source: `src/app/modelState.ts` and
`src/app/runtime.ts`. Start with a policy allowing only the initial fake-model ID; request
`forbidden/model` through `Runtime.setModel`. Expected: rejection before provider creation.
Original observation: `ok: true`. Repair status: resolved in the model-policy enforcement patch.
The requested and resolved IDs are checked before provider construction. The original G01 assertion
now passes as an ordinary test. `test/model-policy-enforcement.test.ts` verifies forbidden provider
factory count zero, unchanged model/session/journal after denial, `/models` names/aliases/numbers,
policy loaded from disk, allowed wildcard switching, startup, resume and session switching, custom
agent selection and resolver remapping, exploration and specialist child models. Allowed child
requests and the existing non-Claude alias fallback retain positive coverage. All clients are fake.
Policy is loaded at runtime creation; hot reload and retroactive revocation during in-flight requests
are not introduced by this repair. Remaining milestone M1 work is G02 to G04.

## G02 Network allowlist policy precedence

Priority P0, milestone M1, owner security/runtime maintainer. Source: `Runtime.networkDecision`.
Put `blocked.test` in both the proxy's configured hosts and the team blocked list. Expected:
`allowed: false`. Observed: `allowed: true` from the fast path. The reproduction invokes the decision
component without a socket. Follow-up: instrument a local proxy to prove no outgoing connection;
cover remembered consent, direct fetch, redirects and strict allowlist semantics.

## G03 Required sandbox with no isolation

Priority P0, milestone M1, owner permissions maintainer. Source: `src/permissions/engine.ts` and
`src/sandbox/index.ts`. Request a harmless command with isolation `none`, `requireSandbox: true`,
no escape flag and an approving user. Expected: denial. Observed: allowed. No shell command runs.
Explicit escape denial has existing positive coverage. Follow-up: test runtime startup, host mode,
unavailable OS sandbox fallback and actual macOS/Linux executor behaviour.

Resolved (merge gate): with `requireSandbox`, the engine treats isolation `none` like an escape, so
every command is denied with "The team policy requires the OS sandbox". The G03 assertion is an
ordinary test; `test/policy.test.ts` keeps the positive control (the same command is allowed with an
OS sandbox). Not covered yet: a real host without Seatbelt or bubblewrap.

## G04 Denied paths in bulk operations

Priority P0, milestone M1, owner tools/permissions maintainer. Source: `src/tools/grep.ts`, registry
permission descriptions and knowledge index. Create policy-denied `private.ts` with an ordinary
marker and run content grep through the registry. Expected: marker absent. Observed: denied source
content returned. Direct denied-path checks already work. Follow-up: glob, indexing, canonical
aliases, symlinks, shell reads/writes and protection of the policy authority. Only grep leakage is
reproduced here; these other routes remain explicit evidence gaps.

## G05 Writable specialist scheduling

Priority P0, milestone M2, owner agent runtime maintainer. Source: `src/agents/moe.ts` and
`src/loop/toolRunner.ts`. Dispatch two specialists through the real parent scheduler; each fake child
calls a controlled mutating `write_file` probe. Expected: peak active mutations is one. Observed:
peak is two and both fixture writes complete. The two writes use different temporary files; this
proves concurrent admission, not a particular lost-update outcome. Follow-up: same-file races,
read-only child capabilities, plan mode, independent file scopes and cancellation/process cleanup.

Resolved (merge gate): `delegate_expert` has `runsAlone: true`, so the scheduler runs specialist
calls one at a time (peak one). The G05 assertion is an ordinary test. MoE is also off unless
`moe.enabled` is true. Not covered yet: a future parallel mode with separate file scopes.

## G06 Child budget and synthesis

Priority P0, milestone M2, owner agent runtime maintainer. Source: `src/agents/child.ts` and
`src/loop/runAgent.ts`. Set one step and one token, then have the fake model return a tool call with
15 usage tokens. Expected: no unreserved second model request. Observed: two requests, including
wrap-up. The unknown probe tool has no side effect. Follow-up: shared parent reservations,
concurrent admissions, compaction, retries, cancellations, costs and policy limit inheritance.
Aggregate-parent enforcement is not fully reproduced by this single-child scenario.

## G07 Audit confidentiality and completeness

Priority P0, milestone M3, owner security/observability maintainer. Source: `src/audit/logger.ts` and
`src/agents/child.ts`. Three scenarios reproduce distinct gaps:

- Synthetic `token=m0_canary_secret_123456` is persisted in a command target even though the session
  redactor recognises it. Expected: no canary bytes in audit storage.
- A file occupying `.garuda` causes persistence to fail. Expected: error surfaced to the caller.
  Observed: the logger resolves silently. A governed failure policy still needs product definition.
- A fake child reads a fixture through an audited permission engine. Expected: permission and
  execution outcome events. Observed: permission exists; execution outcome is absent.

Follow-up: parent/child/call correlation, validation and hook denials, cancellation, concurrent
logging, protected audit destinations, rotation and externally anchored integrity. Tamper detection
is not tested as a finished feature: JSONL currently has no verifier. Define the threat model and
integrity claim before designing M3 tamper acceptance tests.

Merge gate (2026-10-02): the first two scenarios are resolved and are ordinary tests. Targets and
reasons pass the session redactor. A write failure throws when the team policy sets
`audit.enabled: true` (the governed failure policy), else one notice. The log moved out of the
project to `~/.garuda/audit/<project>-<hash>/`, one file per process, and each line is chained
(`seq`, `prev`, `hash`); `verifyAuditFile` and `/audit verify` detect a changed, removed or inserted
line. Integrity claim: tamper-evident against edits of single lines, not tamper-proof (a writer can
rebuild the chain; external anchoring is still open). The third scenario (child execution outcome)
stays open.

## G08 Code intelligence precision and coverage

Priority P1, milestone M4, owner language tooling maintainer. Source: `src/knowledge/index.ts` and
Python extractor. A module-level call after `helper` is attributed to `helper`, rather than
`<module>`. An unresolved `missingSymbol` is reported with low risk. Desired: correct scope and no
confident low-risk verdict for an unresolved target. The latter also resolves as a file-like target
in this fixture, illustrating uncertainty in target classification. Follow-up: a labelled
five-language corpus with declaration boundaries, aliasing, shadowing, precision, recall and
truncation/freshness checks. No full semantic call-graph claim is made by M0.

## G09 Plugin dependency trust

Priority P1, milestone M4, owner plugin/security maintainer. Source: `src/knowledge/plugins.ts`.
Approve an unchanged MJS entry that imports a CJS dependency, change the dependency, then discover
the plugin in a fresh temporary module path. Expected: rejection of the changed unapproved package.
Observed: the imported changed plugin ID loads. Existing entry-hash checks remain intact. Follow-up:
package closure, symlink replacement, load-time races, revocation and execution containment. The
probe changes metadata only; it does not attempt privileged host access.

## Evidence disposition

A repair closes a scenario only after its desired assertion passes as a normal test and neighbouring
permitted operations remain valid. Expand route coverage in the milestone named above. A passing
M0 harness check is not an exemption for any open P0 issue or evidence gap.

## U0 Selective hunk approval (from the hands-on review)

Resolved (merge gate, 2026-10-02). Rejected hunks never reach the disk: the chat passes the accepted
hunk numbers through `ApprovalRequest.selectHunks` and `PermissionDecision.hunks` to `edit_file`, which
applies only those (`applyHunks`). Review is offered only when the preview shows every hunk. Effect
tests in `test/hunkApproval.test.ts` check the file for n/y (the reproduction), y/n, y/y and n/n, and
that nothing is written when the file changed during the review.

