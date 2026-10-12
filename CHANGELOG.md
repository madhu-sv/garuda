# Changelog

## 0.17.0 (unreleased)

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

## 0.16.2 (unreleased)

- Design for 0.17 (planned, no code yet): staged commands (a command's changes ask before they
  reach the project, opt-in), job write scopes, a strict profile, an audit checkpoint, one token
  budget for the agent tree, and approximate labels for Java and Python references. See
  docs/lld/bounded-changes.md.
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
