# Changelog

## Unreleased

- Biome 2.6.2 (with @inquirer/prompts 8.7.4, react 19.3.1 and smol-toml 1.9.1, from Dependabot's
  group update). Biome 2.6 formats Markdown and YAML by default: Markdown formatting is off (the
  docs keep their own layout), and pnpm's lockfiles are left out.
- Dependabot: `@types/node` stays on the oldest supported Node line (no major updates); each other
  major update comes as its own pull request.
- The Homebrew formula in the repository names 0.17.0 and its tarball hash.
- Eval evidence, part 1 (T11a): the report gives the pass rate over all attempts with a 95%
  interval (a cluster bootstrap over tasks, so repeats of one task count together), the tasks that
  passed every run or none, the median and p95 of steps, tokens and time, the cost per accepted
  change (all attempts divided by the passes), and unexpected changes (files that a run changed
  but the task did not need; a new `allowChanges` field widens a task's scope). `--shuffle` and
  `--seed` set the run order. `report.json` is version 2, with Garuda's version and commit, the
  model, the OS, the seed, the run order and a hash of each task. A run whose every attempt failed
  with an error gives no interval ("No scored run"), a task with only error runs is not counted as
  "passed none", and an authentication error (401 or 403, for example a refused API key) stops the
  eval at the first run instead of failing every run the same way.
- `garuda eval compare <a> <b>` (T11a part 2): two reports of the same tasks side by side, the
  difference of the pass rates (B − A) with a paired 95% interval, and each arm's cost per accepted
  change, unexpected changes and median time. It refuses reports whose tasks differ, and a
  difference whose interval contains 0 is "no clear difference". The run report now says when its
  interval is only a rough guide (fewer than 10 tasks, or every draw gave the same rate).
- The Claude Code baseline (T11b): `garuda eval --agent claude-code` runs `claude -p` on the same
  tasks with the same scratch folders, time limit and grading, so `garuda eval compare` can set
  Garuda against Claude Code. Claude Code runs with every tool allowed, so only in the OS sandbox,
  with network only to `api.anthropic.com`, a new config folder per run, and the API key in its
  environment only. Its turns, tokens and cost come from its JSON result. `eval compare` prints a
  zero difference as "0 pts" and says when every draw gave the same difference. The user's first
  live baseline run found that the proxy for `api.anthropic.com` started only in a Garuda turn, so
  Claude Code had no network: the runner now starts it first (`Runtime.prepareCommands`). An eval
  now also stops at the first run that cannot reach the API (a refused connection, an unknown
  host, a certificate error), as it does for a refused key.
- `garuda eval compare` also compares the cost per accepted change: the ratio B/A with a paired
  95% interval, and a verdict ("B costs more", "B costs less" or "no clear difference"). An unknown
  cost gives no ratio. The hard-coupon task allows changes in the coupon module and the API routes
  (`allowChanges`): both agents made them in the first baseline runs. Its task hash changes, so
  compare new hard-suite runs only with new ones.
- A held-out set (T11c): 10 new, harder tasks in TypeScript, Python and Java, apart from every
  suite. `--split heldout` runs them, `--split all` runs them with the dev tasks, and a plain
  `garuda eval` never does (a held-out id with `-t` is refused with the fix). They cover a defect
  whose cause is in another file (3), a refactor across modules (2), tests that a mutation check
  must find good enough (2), conventions from the repository's `AGENTS.md` that a hidden test
  checks (2), and a vague request (1). Each task's hash is recorded in the tests: a changed task
  must change its hash on purpose, and a tuning result seen before the change is invalid.
  `report.json` records the split. `--list` shows the held-out set. The compare note now says
  "the same pass-rate difference".
- The first held-out run (Haiku 5.5, 3 runs a task: 27/30) found a fault in one task:
  the export-dates task (now `med-export-dates`) failed 0/3 only because the agent, with the right fix each time, added a CSV
  test to the protected test file. Its hidden test decides, so the visible tests are no longer
  protected, and a new test is in scope there and in the two conventions tasks. The hashes of these
  three tasks change: compare held-out runs only with runs made after this change.
- A harder held-out set (T11c, second version). The first set was at its ceiling for Haiku 5.5,
  so it is now a dev suite, `-s medium` (ids `med-…`), and 10 new tasks took its place. Each has a
  trap: a quick fix that passes the visible tests fails the hidden test or the mutation check (a
  cache key without the currency, a new idempotency key per retry, invoice shares and yen, a
  command registry with unchanged output, settings by the README's rules, 6 subtle mutants in two
  test-writing tasks, a migration and a reset endpoint by `AGENTS.md`, and a slow search that must
  keep every result). Their ids start with `held-out-`. The tests prove each trap. Compare
  held-out runs only with runs made after this change. The run report's id column now fits the
  longest id, so the columns after it line up.
- The second held-out run (Haiku 5.5, 3 runs a task: 28/30) found two faults, both in the checks.
  `held-out-conventions-migration` failed 2/3 with correct work: the agent named the field
  `dueAt` (as `created_at` suggests), and the hidden test read `dueDate`, which the prompt never
  named. The prompt now names it. The report gave "The check failed:" with nothing after it: a
  guard stopped the check with no output. Each guard now prints what is missing, and a check with
  no output reports its exit code. Four held-out hashes change.
- Tests: `test/evals.test.ts` self-tests the basic and hard suites only (the medium tasks ran twice
  there), with 60 s for each task. The user's `pnpm check` timed out on `hard-rounding` at 5 s,
  then on the LSP reference sample. `vitest.config.ts` now gives every test 30 s, the limit that
  the release checks used, so `pnpm check` agrees with them.
- The third held-out run, with the Claude Code baseline, ran an old build: `dist/` was older than
  the checkout, so the old tasks ran, and `report.json` named the checkout's commit, not the
  build's. A build now records the commit it came from (tsup sets it), `report.json` gives it as
  `garuda.commit` and adds `garuda.checkout` when the checkout differs, and `garuda eval` warns
  at the start: "This build is from commit …, but the checkout is at …: run pnpm build first."
- Held-out prompts with visible tests now say "You may add tests in new files, but do not change
  the existing test files": in the same run the agent appended a correct test to a protected test
  file after "do not change the existing ones". Five held-out hashes change.
- Same run, same (old) tasks, Haiku 5.5: Garuda 26/30, Claude Code 27/30, no clear difference in
  the pass rate; Claude Code cost ×1.50 per accepted change (paired interval ×1.35 to ×1.71).
- Design (T11; T11a and T11b built, T11c–d not yet): eval evidence — intervals and consistency over repeated runs, cost per
  accepted change, unexpected changes, a Claude Code baseline runner, a held-out task split, and a
  proposer loop that edits only a prompt addendum (`docs/lld/eval-evidence.md`).

## 0.17.0 (2026-10-27)

- macOS: no command process outlives the command (IPI-04). Seatbelt has no process namespace, so a
  process could leave the command's process group (setsid, setpgid, posix_spawn with SETSID or
  SETPGROUP, Node's detached spawn) and keep running, inside the sandbox. Each sandboxed command now
  gets two marker files in its Seatbelt profile, and after the command a small helper,
  `native/bin/garuda-reap` (C, universal arm64 + x86_64, ad-hoc signed, built in the release
  workflow and shipped in the npm package), kills every process of the user with those markers. On
  the user's Mac all four ways out were found and killed, no other process matched, and one scan took
  12 ms. The bash tool tells the model when Garuda killed such a process. Without the helper (a
  source checkout without the Command Line Tools, the standalone binary) Garuda warns, and the
  strict profile refuses sandboxed commands. The IPI-04 case now expects no escape on macOS too.
- Node and dependency security (2026-10-21): Garuda warns at start on a Node without the latest
  security fixes of its line (22.23.4, 24.22.1, 26.12.1; the Node.js security release of
  2026-10-21: TLS hostname checks, DNS, Brotli), and `engines` names those versions. CI, the
  release and website workflows take the newest Node of their line (`check-latest`) and stop on an
  older one (`scripts/check-node.mjs`); `pnpm package` refuses one for the standalone binary. A new
  Audit workflow (each push, pull request and Monday) fails on any advisory in a shipped package;
  Dependabot opens weekly updates. `@modelcontextprotocol/client` 2.3.1 fixes two advisories in
  the OAuth and HTTP transport of remote MCP servers (GHSA-6qxp-vccf-f47h, GHSA-6prh-2h8m-c8cw).
  `glob` and `grep` refuse a pattern that brace expansion makes into more than 1000 patterns or
  that nests `{…}` more than 10 deep: `braces` has no fix for GHSA-vfj7-8cjw-p6xm, and such a
  pattern ran Node out of memory. See docs/security-deps.md.
- zod 4.6.7: GHSA-mrhx-c7xc-m3w5 (high), one oversized array could run Node out of memory
  during validation. zod checks the model's tool input and, in the MCP SDK, the messages of MCP
  servers. The new Audit workflow found it.
- GitHub Actions: `actions/checkout` 7.0.1 and `actions/setup-node` 7.1.0, which run on Node 24
  (GitHub forces actions built for Node 20 onto Node 24 and warns). Still pinned to full commit
  hashes. The release job turns off setup-node's automatic dependency cache.
- Indirect prompt injection suite (`test/ipiSuite.test.ts`): ten injected-call cases against the
  real sandbox, permission engine, tools, web_fetch, audit log and approval display, each with a
  control; `pnpm ipi:mutations` shows that every case fails without its defence. Two known gaps are
  recorded: sandboxed commands may write the shared package caches (IPI-03), and on macOS a
  process in a new session outlives the command (IPI-04).
- Docs: the README is short now (what Garuda does on your machine, install, quick start, links);
  the user guide moved to `docs/guide/` (ten pages; the website shows them as the User guide
  section). New community files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, a pull request template
  and issue forms for bugs and features. `SECURITY.md` names 0.16.x as supported.
- Models: Claude Sonnet 5.5 and Haiku 5.5 with their prices (Haiku 5.5 has a higher price for
  prompts over 100,000 tokens); `sonnet` and `haiku` now name them. `garuda setup` lists the
  models of your Anthropic account (Models API) and saves the list for `/models`; a model that
  this Garuda does not know shows "price unknown". `pnpm models:check` is a release check.
- Staged commands (T5, off by default): with `"commands": { "mode": "staged" }`, each sandboxed
  command runs in a staging copy of the project; when it changes files that git tracks, you see the
  diff and apply or discard (all or nothing, with `/undo`). Ignored files stay in the copy. No copy:
  the session does not start (no fallback to direct mode). Linux mounts the copy at the project's
  path; macOS runs the command at the copy's path with the project read-only. The question also
  counts the ignored files that the command wrote (never applied) and names sensitive ones.
- MoE wording (review of 3a9f51b): the `delegate_expert` description and the system prompt no
  longer promise "deep language AST tools"; they name the code index tools and say that results
  outside JS/TS are approximate. A test guards public and model-facing text.
- Job and night-digest costs (review of 3a9f51b): an incomplete cost shows as "≥ $X (incomplete)"
  and an unknown cost as "unknown" (before: exact $0.5000 and $0.0000), also in the totals and
  for the review. A review attempt with no reported usage marks the review cost incomplete; an
  estimated review response costs 0 as a minimum instead of an estimated price.
- Executor contract test (Codex review of 1370184): after `shutdown()`, the shell and any sandbox
  wrapper must be gone too, not only the background child.
- T10 evidence (Codex review of 1370184): the corpus, oracle and source fingerprints are hashed
  with LF line endings, so a Windows checkout with CRLF passes the evidence tests. The published
  values do not change.
- Token budget (Codex review of 1370184): while tools run, the room that subagents must leave
  for the parent also covers a compaction that is due before the next request.
- Subagent spend with no report (Codex review of 1370184): a cancelled child's tokens, already in
  the budget, now make the cost "≥ $X (incomplete)" and show the budget line, with the part from
  subagents named.
- Docs (Codex review of 1370184): Go and Rust experts are heuristic, not AST parsers; MoE
  specialists get the code index tools, not "full AST" tools; the T10 record says that only one
  capture is stored; the README states what the precision/recall figures do and do not cover.
- T10 evidence guard (Codex review of 1370184): fixed precision/recall floors (Java 33/54 and
  33/36, Python 45/63 and 45/48) apply on every run, also during an evidence refresh; a refresh
  variable set in CI fails the test.
- Approximate references (Codex review of 1370184): Go and Rust references, and every user or
  project plugin's, now carry the same approximate warning as Java/Python in tools, chat, callers
  and impact. Tool descriptions name these languages.
- TypeScript references (Codex review of 1370184): the search starts at the declaration's own
  name, not at the first matching word on its line, which could be another symbol (a property of a
  type declared earlier on the line).
- Jobs (Codex review of 1370184): a review that was asked for but failed (a provider error, no
  budget) gives the verdict "needs a look", never "ready to merge". The error stays in `reviewError`.
- JSON output (review of 1370184): `total_cost_usd` stays a number for compatibility, but an unknown
  or partial cost is never a bare number: new `total_cost_is_unknown`, `total_cost_is_incomplete` and
  `cost_is_incomplete` flags, beside the existing `cost_is_unknown`.
- Cost after a failed attempt (review of 1370184): one retry, 529, batch fallback or cancel no
  longer makes the cost unknown for the rest of the session. The cost stays a known minimum, shown
  as "≥ $X (incomplete)" in the turn line, `/usage`, `/sessions`, job reports and eval reports, also
  after a resume. Only a missing price makes the cost unknown.
- The job review is under the token budget (Codex review of 1370184): its request reserves first
  (a one-token policy no longer lets an 8,192-token request through), every attempt is metered, and
  its usage counts for the session and on resume.
- Team policy `denyPaths` in the OS sandbox (Codex review of 1370184): when the patterns match more
  than 1,000 paths, commands stop with a message instead of running with only the first 1,000
  protected; the patterns now find files in every folder, also `node_modules` and `.git`
  (review of 3a9f51b: `**/private.txt` had no sandbox rule in `node_modules`).
- Code intelligence (T10): Java/Python reference results carry `approximate: true`, propagated to
  callers and impact, including empty results. Model tool output starts with a warning; chat adds
  `≈`. Impact risk is labelled heuristic. Matching algorithms are unchanged. A frozen 30-Java/
  30-Python corpus, captured with jdtls 1.61.0 and pyright 1.1.406, records precision and recall;
  offline regression checks verify the oracle, source fingerprints and published results. A
  supplementary manually labelled edge-case sample records stricter alias semantics separately.
- Token budget, review of b2bf1c2: successful OpenAI-compatible responses with missing, partial
  or invalid usage keep their full reservation charged. Estimates remain labelled on responses
  for context sizing, but do not enter reported session or child totals, avoiding a double charge.
  The existing `unreported` records preserve the charge across resume; affected costs are unknown.
  Usage displays and JSON distinguish budget charges and estimates; evals mark incomplete token
  totals and means unknown. Legacy journals remain readable with their historical totals.
- Token budget, review of 597104a: every input reservation covers the full current request,
  including changed instructions, tool definitions and server-tool settings on resume. A larger
  previous measured context plus new messages is still kept. Oversized requests stop before a
  provider call; small budgets may refuse calls earlier. Existing journals need no migration.
- Token budget, review of 6c9f929: metered Anthropic batch submission disables SDK retries;
  reported child debits survive cancellation, parallel failures and resume, without duplicating
  report aggregation. Started parallel calls settle before the turn ends. Complete results are
  capped after hooks and on errors (20 000 characters for subagents, including metadata; 100 000
  otherwise), also for custom/replay runners. The final-answer floor accounts for JSON escaping
  and result-message structure; small budgets can refuse child work earlier. Compaction reserves
  its system prompt and the rest of its full request. Existing journals remain readable.
- Token budget, review of 31aab17: a subagent's wrap-up request is reserved in full (system prompt
  and tools too); every provider request reserves, also an HTTP retry and a batch job's switch to
  the normal API (the Anthropic SDK no longer retries on its own under the budget; the loop retries,
  also a rate limit); the parent's room for its final answer covers the results of its calls (a
  tool result is at most 100 000 characters, a subagent's answer at most 20 000); charges for
  failed requests stay with the session, also after a resume; `/compact` counts against the budget.
- One token budget for the turn and its agent tree (review T9): each model call reserves its request
  and output limit first, and the run stops with `token_budget` when they do not fit; subagents,
  compaction and retries reserve in the same budget; parallel subagents cannot pass the parent's cap,
  and they leave the parent room for its final answer. A failed or cancelled call with no reported
  usage counts as fully spent. A small `tokenBudget` now stops a run before the call that would pass
  it, not after.
- Job write scopes, third review: a job never runs a command outside the sandbox, also when an
  allow rule matches (`outside_sandbox` dropped the scope); an edit through a symbolic link must
  reach a path in the scope, checked by the engine and again by the write tool just before it writes;
  the job's test command has the same scope as every other command, and the approval question says
  so. Claims: without a sandbox, a command (or an MCP call) asks unless an allow rule covers it; undo
  covers the files in its snapshot. The claims test knows these phrases.
- Job write scopes (review T6): `/schedule` proposes `"writeScope"`, the paths in the worktree that
  the job may change (the plan's edit and write paths, and the build folders), and the question
  shows it. The OS sandbox makes the rest of the worktree read-only for the job's commands, the
  engine denies edits outside it, and a change outside it fails the job with no commit. Jobs without
  a scope say "Commands may write anywhere in the worktree."
- Design (second review): staged commands never fall back to direct mode and never apply an
  incomplete change list; the shared budget keeps a reservation as spent when a request fails or is
  cancelled with no reported usage (docs/lld/bounded-changes.md).
- Exact claims, second pass (second review): the sandbox writes the project, temp folders and
  package caches (not "only the project"); a command outside the sandbox asks unless an allow rule
  or a session answer covers it (not "always"); `/undo` restores the files in its snapshot, not
  ignored files (not "what a turn changed"). The claims test now reads whole paragraphs and knows
  these phrases.
- Audit checkpoint fixes (second review): a failed checkpoint write no longer makes the next audit
  line repeat the sequence number and chain head (the chain was broken); a checkpoint or a folder
  that cannot be read is reported as broken, not as "no checkpoint" or "no files".
- Audit checkpoint: with `"audit": { "checkpoint": true }` in a policy file (off by default),
  Garuda keeps each log file's last `seq` and `hash`, and `/audit verify` finds lines cut from the end
  of a file and a deleted file. The docs list what verify detects with and without it (review T8).
- The strict profile: `"profile": "strict"` in a policy file or in `.garuda/settings.json` requires
  the OS sandbox. Without one, Garuda stops at startup with the reason; `"executor": "host"` is an
  error; the `bash` tool has no `outside_sandbox`. A project can turn it on, never off (review T7).

- Also in this release: the changes planned as 0.16.2, which was never published. Docs that say
  "0.16.2" mean this release.
- The design of the bounded-changes work above (staged commands, job write scopes, the strict
  profile, the audit checkpoint, one token budget for the agent tree, approximate labels for Java
  and Python references): docs/lld/bounded-changes.md.
- Exact safety claims (an external review found an overclaim): edits ask first, but commands in the
  OS sandbox run with no question, inside its limits, so they can change project files (`/undo`
  restores them). The website, the blog posts, the share image, the README and the editor's mode
  text said that every change asks first; they now say what each limit does. A test keeps the old
  phrases out.
- Tests skip cleanly where a machine has no OS sandbox, refuses Unix sockets, or cannot change a
  file's owner (found by the same review): the sandbox tests no longer fail while they register,
  the editor tests ignore the "No OS sandbox" notice, and the proxy and ownership tests skip with a
  reason. Checked with a PATH that has no bubblewrap: 0 failures.
- `garuda eval` reports success two ways: over the scored runs (error runs left out) and over all
  attempted runs (error runs count as failures). `report.json` has both in `summary`.
- The system prompt names Garuda's version and the model, so "which model are you?" gets a true
  answer. After `/models`, the next message tells the model about the switch; the system prompt
  stays the same bytes, so the prompt cache stays valid.
- Website: a share image and share tags (LinkedIn, X and chat previews) on every page, structured
  data on the landing page, and a place for the Google Search Console tag (`site/src/seo.ts`; see
  docs/release.md). More npm keywords.
- Website: comments under blog posts (giscus: threads with replies, stored as GitHub Discussions,
  sign-in with GitHub) and a contact page. Both use `site/src/community.ts`; empty values hide them.

## 0.16.1 (2026-10-06)

- `garuda acp` offers its sign-in (Terminal Auth) also to clients that declare the capability in
  its older form, `_meta["terminal-auth"]`. The ACP Registry's checker sends only that form, so
  0.16.0 answered it with no sign-in method and failed the registry's auth check.

## 0.16.0 (2026-10-06)

Setup for editors and the ACP Registry (design: [docs/lld/setup.md](docs/lld/setup.md)).

- Stored provider keys: Garuda reads `~/.garuda/credentials` (JSON, key name → key) when no
  environment variable sets the key. It reads the file only when it is a regular file (not a link),
  owned by you, with mode 0600; else it ignores the file with a warning. The key never enters
  Garuda's environment, and the redactor knows it. `garuda setup` writes this file.
- Commands in the OS sandbox cannot read `~/.garuda/credentials` (macOS and Linux).
- `"default"` in `~/.garuda/models.json`: the model when neither `--model` nor `GARUDA_MODEL` names
  one.
- The redactor removes every provider key that Garuda keeps, also one whose variable name does not
  look secret (a custom provider's `apiKeyEnv`).
- `garuda setup`: choose a provider and a model, enter the key once (hidden input), check it with
  one free request to the provider, then store the model as the default and the key in
  `~/.garuda/credentials`. `--show` shows where each key comes from (masked); `--forget [NAME]`
  removes stored keys. With no terminal, it stops with a message.
- The messages for a missing model or key name `garuda setup`.
- `garuda acp`: Terminal Auth. An editor that can run it (`auth.terminal`) gets a "Set up Garuda"
  method; it runs `garuda acp setup` in a terminal. A session with no model or no key fails with
  ACP's "auth required", so the editor offers the setup. The setup is read again for each new
  session: no restart after `garuda setup`.
- Native Windows: `garuda acp` sessions and `garuda setup` stop with a message to use WSL.
- Docs: `garuda setup` in the quick start, the landing page, the README and the Editors page; editor
  entries need no API key in their settings. Tested live in Zed 1.22: with no model and no key, Zed
  offered the setup, ran it in a terminal, and the next thread worked with no restart.
- `-p --output-format stream-json`: `apiKeySource` in `system/init` is `credentials` for a stored
  Claude key.

## 0.15.0 (2026-10-06)

Garuda in your editor. Version 0.15.0 is not the old "0.15" branch label of the status table (code
intelligence), which shipped in 0.14.0.

### Editors

- `garuda acp`: Garuda as an agent for editors over the Agent Client Protocol (v1): VS Code (with
  the "ACP Client" extension), Zed, JetBrains, Neovim, Emacs. One runtime per editor session, with
  the same permission engine, OS sandbox, team policy, hooks and audit log as the terminal.
- Approval questions name their tool call (`callId`), and file writes carry the whole change, so an
  editor shows each question next to the right call, with its own diff view.
- A stop in the editor names what it ended: each stopped tool call shows as failed, with a line
  such as "Garuda: $ sleep 60 cancelled." (or "the turn was cancelled." when no call ran). A call
  that has not reported within 3 s of the stop ends as failed, so none stays "running".
- Docs: the website's Editors page (VS Code with ACP Client, Zed, other ACP editors). Tested live
  in VS Code and Zed on macOS.

## 0.14.1 (2026-10)

The first version on npm (`@garuda-agent/garuda`) and Homebrew (`madhu-sv/garuda/garuda`). It fixes
the open findings of Garuda's own review: the cli and extensions areas are new, and the low findings
of the other areas are closed. Each fix has a test that fails without it.

### Install

- npm: `npm install -g @garuda-agent/garuda`. Published from the release workflow with npm trusted
  publishing, with provenance.
- Homebrew: `brew tap madhu-sv/garuda`, `brew trust --formula madhu-sv/garuda/garuda`, then
  `brew install garuda`.

### Security

- Approvals show hidden characters in a command (controls, invisible and bidirectional
  characters), with a warning line. A carriage return or an escape code can no longer make a
  command look like another one.
- Eval checks run the agent's code in the run's OS sandbox, not on the host.
- Instruction files and `.garuda/memory.md` are read only when their real path is in the root.
- A project's formatter commands need the user's yes at startup, and the team policy checks them.
- Hook commands show as one clean line in the consent and in `/hooks`.
- Skill descriptions and MCP tool schemas cannot carry Garuda's markers.
- MCP: a project server's sign-in page may not be plain http on this machine; the consent warns
  about secrets taken by `${NAME}` and about write paths outside the project.
- Job links must be single folder names.
- The jdtls install stops when its checksum file is missing.

### Fixes

- Parallel eval tasks no longer kill each other's commands. All runtimes shared one sandbox
  executor, so a task that ended stopped the checks and commands of the others. Each runtime now
  has its own executor.
- A failed subagent still reports its tokens and cost; a child journal has one end record;
  children get the parent's diagnostics and formatters.
- The compaction summary call is retried after a dropped connection.
- A model client that fails to start is not cached.
- `grep` runs its pattern in a worker thread: a pattern that backtracks badly no longer blocks
  Garuda.
- `web_fetch` keeps at most 50 pages in its cache.
- Two MCP servers with the same tool name no longer stop every MCP start.
- Approvals ask one question at a time; the Ink chat drops keys for 400 ms after a question
  appears, so type-ahead cannot answer it.
- A job never stays "running" after `garuda run` stops.
- Plain chat: Ctrl-C during a `!command` stops the command, not Garuda.
- Arguments of commands and skills are inserted once: `$5` or `$&` stay as typed.
- `/init` skips symbolic links in a project's command folders.

### Known limits

See the README, under the status table.

## 0.14.0 (2026-10-03)

The 0.14–0.17 branches after the merge gate and Garuda's review of seven areas (knowledge,
permissions, tools, sandbox, audit, loop, agents). See
[docs/quality-baseline/validation-record.md](docs/quality-baseline/validation-record.md).
