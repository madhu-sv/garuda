# Reads only where needed (T15): design

Status: designed (2026-11-09); the user's decisions are below. Nothing here is built yet. The user
decides the default after the measurement.

## The problem

A command in the OS sandbox can read every file except a deny list: the secrets in the home
folder (`DENY_READ_IN_HOME`) and, since 0.18.1, the personal folders (`PERSONAL_IN_HOME`). So it
can still read the user's other projects, their notes, their shell history, and any secret that is
not on the list. A deny list is never complete: 0.19.0 had to add `~/.config/anthropic/credentials`
because a new tool started to keep keys there.

The status page names this as a known limit. T15 turns the list around: commands read the project,
the toolchains, the package caches and paths that the user names. The rest of the home folder is
denied.

## What exists today

- **macOS (Seatbelt).** `(allow default)`, then `(deny file-read* …)` for the deny list. Each path
  under `/Users` also under `/System/Volumes/Data` (`withDataVolume`, 0.18.1).
- **Linux (bubblewrap).** `--ro-bind / /`, then the write paths writable again, then each denied
  path covered by an empty tmpfs or `/dev/null`.
- **Repo-task evals (0.18.1, 0.18.2).** Already close to T15: `repoTaskReadDenials` denies the whole
  home folder except its hidden entries and `~/Library`, and the checkout except its links. Three
  live failures came from this: pnpm in `~/Library/pnpm` (0.18.2), Vite's `.vite-temp` in the
  linked `node_modules` (0.18.2), and tests that start their own sandbox (left out by the suite
  builder). They show what this design must cover.

## Goals and non-goals

Goals:

1. A mode in which a command reads, in the home folder, only the project, the toolchains, the
   package caches, Garuda's skills and the paths that the user names.
2. Builds and tests work as before for Node, Python, JVM, Go, Rust, Ruby and the mobile toolchains.
   The measurement below checks this.
3. When the mode blocks a read, the user and the model learn which path and which setting
   allows it, as the network question does for hosts.
4. The same rules on macOS and Linux.

Non-goals:

- Reads outside the home folder (`/usr`, `/opt`, `/Library`, `/etc`): system tools live there. Two
  exceptions are in the mode: other volumes and the user's runtime folder (below).
- Writes: the write rules do not change.
- Windows: Garuda has no OS sandbox there.

## The mode

Two settings in `sandbox`:

```json
{ "sandbox": { "reads": "needed", "readPaths": ["~/notes/api-spec"] } }
```

- `reads`: `"open"` (today's rules) or `"needed"` (this design). The default stays `"open"` until
  the measurement; then the user decides.
- `readPaths`: extra readable paths. `~/` is the home folder; relative paths start at the root. A
  project setting that adds a path outside the project loosens safety, so it needs the user's yes
  in a terminal, as other such settings do (0.14).
- A team policy can require `"needed"`; then a project or user setting cannot turn it off. The
  strict profile does not imply it (decision 1).

The deny list stays in both modes and wins over every allow rule: a secret inside a readable folder
stays unreadable.

## What is readable in "needed" mode

In the home folder, the union of:

1. **The project**: the root, its write paths, and the targets of its links (`node_modules`,
   `.venv` and `venv`, as the task copies link them).
2. **The toolchain prefixes on `PATH`.** Every `PATH` entry inside the home folder; for an entry
   that ends in `/bin`, its parent (the prefix: `~/.nvm/versions/node/v22.23.4/bin` gives
   `…/v22.23.4`, where npm's own modules are). This one rule covers nvm, fnm, volta, mise, asdf,
   pyenv, rbenv, the Cargo and Go bins and `~/.local/bin`, whatever the user has.
3. **Folders that tools name in the environment**, when they are in the home folder: `NVM_DIR`,
   `VOLTA_HOME`, `PNPM_HOME`, `BUN_INSTALL`, `PYENV_ROOT`, `VIRTUAL_ENV`, `CONDA_PREFIX`,
   `GOPATH`, `GOMODCACHE`, `CARGO_HOME`, `RUSTUP_HOME`, `SDKMAN_DIR`, `JAVA_HOME`,
   `GRADLE_USER_HOME`, `MAVEN_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `PUB_CACHE`,
   `XDG_CACHE_HOME`, `XDG_DATA_HOME`.
4. **A fixed list** of toolchain folders and caches (a missing folder costs nothing):

| Ecosystem | Folders (in the home folder) |
| --- | --- |
| Node | `.nvm`, `.fnm`, `.volta`, `.bun`, `.deno`, `.npm`, `.yarn`, `.local/share/pnpm`, `Library/pnpm`, `.cache/node-gyp`, `Library/Caches/node-gyp`, `.cache/ms-playwright`, `Library/Caches/ms-playwright`, `Library/Caches/typescript`, `Library/Caches/Yarn`, `.cache/yarn` |
| Python | `.pyenv`, `.local/lib`, `Library/Python` (macOS `pip install --user`), `.local/pipx`, `.local/share/pipx`, `.local/share/uv`, `.cache/uv`, `.cache/pip`, `Library/Caches/pip`, `.cache/pypoetry`, `Library/Caches/pypoetry`, `.virtualenvs`, `.conda`, `miniconda3`, `miniforge3`, `anaconda3` |
| JVM | `.m2/repository`, `.gradle/caches`, `.gradle/wrapper`, `.gradle/jdks`, `.sdkman`, `.jdks`, `Library/Java`, `.ivy2`, `.sbt`, `.cache/coursier`, `Library/Caches/Coursier` |
| Go, Rust | `go`, `.cache/go-build`, `Library/Caches/go-build`, `.cargo/bin`, `.cargo/registry`, `.cargo/git`, `.rustup` |
| Ruby | `.rbenv`, `.rvm`, `.gem/ruby`, `.bundle/cache` |
| Mobile | `Library/Android/sdk`, `Android/Sdk`, `.android/avd`, `.gradle` (as JVM), `Library/Developer`, `.pub-cache`, `.cocoapods`, `Library/Caches/CocoaPods`, `.swiftpm`, `Library/org.swift.swiftpm` |
| .NET | `.dotnet`, `.nuget/packages` |
| General | `.local/bin`, `.gitconfig`, `.config/git`, `.terminfo`, `Library/Caches/Homebrew` |
| Garuda | `.garuda/skills`, `.garuda/agents`, `.claude/skills`, `.claude/agents` (skill scripts run in the sandbox) |

5. `readPaths` from the settings.

Where a fixed entry names a subfolder (`.m2/repository`, `.gradle/caches`), that is on purpose:
the parent holds a credential file (next section).

Everything else in the home folder is denied, and so are two places outside it:

- **Other volumes**: `/Volumes` on macOS; `/media` and `/mnt` on Linux. External disks and
  backups. The project's own volume stays readable when the project is on one.
- **The user's runtime folder** on Linux, `/run/user/<uid>`: it holds the session bus and the
  keyring sockets (next section).

## Secrets that are not files

**The macOS keychain: no gap (measured 2026-11-09).** A command could try to ask the keychain
service instead of reading the keychain files: `security find-generic-password -s <service> -w`.
The probe on the user's Mac (macOS, Garuda 0.19.0): a test item `garuda-probe` in the login
keychain; the same command in the sandbox answered "The specified item could not be found in the
keychain" (exit 44), and outside the sandbox the item was there. The `security` tool reads the
keychain file to search it, and the sandbox denies `~/Library/Keychains`. Items in the
data-protection keychain belong to apps by their signing entitlements, which a sandboxed command
does not have. So no Mach-service rule is needed. The probe stays in the tests' notes, to run again
on a new macOS version:

```sh
security add-generic-password -s garuda-probe -a probe -w not-a-secret
g -p 'Run this command and show its output: security find-generic-password -s garuda-probe -w'
security delete-generic-password -s garuda-probe
```

**The Linux session bus (not measured).** `secret-tool lookup …` asks the Secret Service on the
session bus, whose socket is `/run/user/<uid>/bus`, and the keyring can answer with no file read.
bubblewrap's `--unshare-net` does not cover a socket in the file system. The fix: an empty tmpfs
over `/run/user/<uid>`, in both modes. Cost: nothing that a build needs uses the session bus. To
check on a Linux desktop with a keyring: store a test item with `secret-tool store`, then look it
up through Garuda as in the macOS probe.

**Credential files inside toolchain folders.** The deny list misses these, and they sit in folders
that builds read:

| File | Holds | Builds need it? |
| --- | --- | --- |
| `.cargo/credentials.toml`, `.cargo/credentials` | crates.io token | No (publish only) |
| `.gem/credentials` | RubyGems key | No (publish only) |
| `.m2/settings-security.xml` | Maven master password | No |
| `.m2/settings.xml` | server passwords, but also mirrors and proxies | Sometimes |
| `.gradle/gradle.properties` | signing and repository passwords, but also JVM options | Often |
| `.yarnrc.yml` | `npmAuthToken`, but also registry settings | Sometimes |
| `.nuget/NuGet/NuGet.Config` | feed passwords, but also feed URLs | Sometimes |

The first three join `DENY_READ_IN_HOME` in both modes. The last four are denied in `"needed"` mode
(decision 3).

## The rules on each system

**macOS.** Seatbelt uses the last rule that matches. After `(allow default)` and the write rules:

```scheme
(deny file-read* (subpath "/Users/me") (subpath "/Volumes"))
(allow file-read* (subpath "/Users/me/dev/garuda") (subpath "/Users/me/.nvm") …)
(allow file-read-metadata (literal "/Users/me") (literal "/Users/me/Library") …)
(deny file-read* …the deny list…)
```

- The metadata rule lets a tool `stat` each folder on the way to a readable path (Node's
  `realpath` does this), but not list it.
- Each path also goes under `/System/Volumes/Data` (`withDataVolume`).
- The deny list comes last, so it wins inside a readable folder.

**Linux.** Mount order decides; later mounts cover earlier ones:

```text
--ro-bind / /
--tmpfs /home/me                    the home folder empty
--ro-bind <each readable path>      read-only again (bubblewrap makes the mount points)
--bind <each write path>            writable, as today
--remount-ro /home/me               the empty tmpfs read-only: a write there fails, as today
--tmpfs /run/user/<uid>  --tmpfs /media  --tmpfs /mnt
…the deny list, as today…
```

Without the last `--remount-ro`, a write to an unlisted home path would land in the tmpfs and
vanish with no error. Today it fails; it must still fail.

## When a read is blocked

A blocked read shows as "Operation not permitted" (macOS) or "No such file or directory" (Linux:
the path is not there in the tmpfs), which looks like a broken tool. So:

- After a command fails, Garuda looks for paths in the home folder in its output that are not
  readable. If it finds one, the result for the model ends with a note: "The sandbox blocked reads
  of `~/x` (`sandbox.reads` is `needed`). Ask the user to add it to `sandbox.readPaths`, or run
  without it." The user sees the same line.
- In chat, the first such block in a session asks the user, as the network question does: allow
  `~/x` once, for this project, or no. A yes for the project goes to `readPaths` in the project's
  local settings.
- In jobs and evals nobody answers, so the block stays, and the eval failure kind is `sandbox`
  (new): the run failed because the sandbox refused a path, not because of the model. The suite
  builder's third check (0.18.2) then leaves such a task out before a model sees it.

## Repo-task evals

They use `"needed"` mode always, with the project root replaced by the task copy and the
checkout's links added. `repoTaskReadDenials` and its special cases (hidden entries, `~/Library`)
then go away: the mode covers them. A user's own `readPaths` do not apply in evals, so results
compare across machines.

## The measurement

The backlog asks for no pass-rate drop. On the Mac, each pair as `eval compare` (paired, same
tasks, same seed):

| Suite | Why |
| --- | --- |
| `repo` (Garuda: pnpm, Vite, native build) | the 0.18.x failures |
| `basic`, `hard` (Node) | the main use |
| `python`, `java` (after `eval --prepare`) | pip and venv; Maven and Gradle |
| `medium` | larger tasks |

Each with Haiku 5.5, `--repeat 3`, mode `open` against `needed`. Cost: about $3 per Haiku pair on
the repo suite, less on the others. Then live checks that no suite covers: an Xcode simulator
build (`swift test`, `xcodebuild … -destination 'platform=iOS Simulator…'`), an Android Gradle
build, and `uv` and conda projects.

Acceptance: for each suite, the pass-rate difference interval contains 0 and its point estimate is
at most 2 points below; no run fails with kind `sandbox`; every live check passes.

## Decisions (the user, 2026-11-09)

1. **The strict profile does not imply `"needed"`.** Strict is not optional for a team that sets
   it, and `"needed"` can rule out tools that an org or a team relies on. The two stay separate
   settings, and a team policy can require either one.
2. **A blocked read in chat: a question and a note**, as for the network.
3. **The four mixed credential files are denied in `"needed"` mode** (`.m2/settings.xml`,
   `.gradle/gradle.properties`, `.yarnrc.yml`, `NuGet.Config`), with a note that names
   `sandbox.readPaths`.
4. **A security patch release first**, in both modes: the Linux runtime folder hidden, and the
   three publish-only credential files denied.

## Plan

1. The session bus on Linux and the three publish-only credential files, in both modes. A patch
   release, because it is a security fix. (The macOS keychain probe found no gap.)
2. `sandbox.reads` and `sandbox.readPaths`, the macOS and Linux rules, and tests that run real
   commands in the sandbox on each system (a denied read, a readable toolchain, the metadata rule).
3. The blocked-read note, the chat question and the `sandbox` failure kind.
4. Repo-task evals on the mode.
5. The measurement; the results go in this note; the user decides the default.

## As built (step 1)

- `sandbox.reads` and `sandbox.readPaths` in the settings; `requireNeededReads` in the team
  policy (merged like `requireSandbox`). A project's `readPaths` need a yes, as `writePaths` do.
- `src/permissions/reads.ts` (`neededReads`, `NEEDED_IN_HOME`, `NEEDED_ENV`, `NEEDED_MODE_DENY`,
  `hiddenPlaces`) and `src/sandbox/readScope.ts` (`ReadScope`, the rule helpers). The engine adds
  the scope to `ExecPolicy.reads` in the sandbox only.
- The rules as above, with two changes from the plan: the write paths in the home folder are
  readable too, and a write path that opens the home folder itself turns the mode off (the user
  made all of it writable). `.gitignore_global` and `.gitignore` in the home folder are on the
  fixed list (git reads the global excludes file).
- A file of `NEEDED_MODE_DENY` that `readPaths` names comes back (the deny list wins otherwise).
- Not yet: MCP servers keep open reads; the blocked-read note, the chat question and the
  `sandbox` failure kind are step 2.
- Checked on Linux (bubblewrap, the real engine and home folder): node, npm with a script, git
  and python ran; a private file in the home folder was "No such file or directory"; `ls ~`
  showed nothing private. The macOS check is the user's live test.

## As built (step 2)

- `findBlockedReads` (src/permissions/reads.ts) finds the blocked paths in a sandboxed command's
  output: paths on lines with a read error ("Operation not permitted", "EPERM", "No such file or
  directory" …) that exist on the host and are outside the scope. On Linux a blocked path looks
  missing in the sandbox, so "exists on the host" is the test, not the message. The deny list's
  secrets are left out (no question for them); the four mixed files are in.
- The bash tool replaces the general sandbox hint with `readsHint` (the paths, "sandbox.readPaths",
  and "do not use outside_sandbox": that advice would run the whole command unsandboxed) and asks
  through `allowReads`: "Let commands read ~/x in this session?", yes for the session or no. A yes
  adds the path to the engine's session paths; the next command reads it. Keeping it for the
  project is the user's own line in `.garuda/settings.json` (as for the network, decision D4 of the
  UX work); `readsKeepHint` names it. No question in jobs and evals, for the home folder itself or
  for a hidden place.
- The eval failure kind `sandbox` (`EvalResult.blockedReads`).
- One design change from step 1, found by these tests: only a write path that is the home folder
  itself turns the mode off. A writable parent (the temp folder that holds a test's home) did too,
  and on Linux it covered the empty home folder. bubblewrap now mounts the write paths outside the
  scope first, and the detection counts only write paths inside the scope as readable.
- Checked on Linux in bubblewrap: a blocked `cat` got the read note and no `outside_sandbox`
  advice; after a yes, the same command read the file.
- The user's live test on macOS (2026-11-09): the question, a yes for the session, the next read,
  and the note for `ls ~` worked. A typo, `head ~/.zshrc.`, then asked about `~/.zshrc`: the
  finder dropped a final dot that was part of the path ("…/.zshrc.: No such file"). Now a final dot
  is dropped only before a space or the line's end. The home folder shows as `~` in notes.


## As built (step 3)

- Repo-task evals run in `"needed"` mode (`repoTaskSandbox` in src/evals/runner.ts), in the agent's
  runs and in the checks that build the suite (`checkAsEval`). The settings come from the eval, not
  from files, so a user's own `readPaths` do not apply.
- `repoTaskReadDenials` no longer denies the home folder (with its exceptions for hidden entries
  and `~/Library`): the mode hides it. In the home folder the original checkout is hidden too, as
  only the links' targets (`node_modules` and the like) are readable. A checkout outside the home
  folder keeps its own rule: the checkout's entries except the links, as the mode covers only the
  home folder and other volumes.
- `garuda eval --reads open|needed` sets the mode for the other suites (default `open`). A wrong
  word fails before anything else. The start line and report.json show `reads`; the repo suite
  always shows `needed`.
- A hole that step 2 left, found here: evals answer with `AutoApprover("once")` and are not
  unattended, so `allowReads` would have asked it and got a yes for every blocked path. A command
  could then read the checkout that holds the answer. The engine option `readQuestions: false`
  (Runtime option of the same name) turns the question off; both eval runtimes set it. Step 2's
  "no question in evals" is true only from here.
- The Claude Code baseline: its real program is readable too (`withProgram`). A native install
  links `~/.local/bin/claude` to a file in `~/.local/share/claude`, outside the scope.
- Checked on Linux in bubblewrap with a fake home folder: a repo task's check read the task copy
  and ran node; a private file in the home folder and the original checkout were "No such file or
  directory".

## Measurement, first run (2026-11-09, macOS, Haiku 5.5, repo suite, `--repeat 3`)

- 0.19.1 (the old deny list): 81 of 88 scored runs passed (2 API stalls). Step 3 ("needed"): 0 of
  72 scored runs passed (18 API stalls, `provider`). The rerun shows whether the stalls repeat.
- Cause: Vitest 5 reads an API token from `~/Library/Application Support/vitest/.vitest-secret-token`
  and else creates one in `node_modules/.vitest`. "Needed" mode hides the first. In an eval,
  `node_modules` links to the project's own, where commands could write only `.vite-temp`, `.vite`
  and `.cache`. In chat the project's `node_modules` is writable, so only evals failed. 0.19.1
  passed because the token already existed and `~/Library` was readable.
- Fix: `.vitest` joins `NODE_MODULES_CACHES`. The token in the home folder stays unreadable; Vitest
  makes its own. A test runs the same logic in the real sandbox.
- A gap in step 2: the runs got the kind `check`, not `sandbox`. Vitest's message has no read-error
  word, and the path has a space ("Application Support"), so `findBlockedReads` saw nothing. A
  failure kind from output text cannot find every blocked read; the paired compare is the real test.
- One run's blocked reads were `~/.garuda` and `~/.garuda/evals`: the model looked for earlier eval
  results there. "Needed" mode blocked it, as designed.
- The rerun with the fix (2026-11-10): 84 of 90 passed, against 81 of 88 for 0.19.1. B − A +3
  points (95% interval 0 to +7); cost per accepted change ×0.99; no API stalls; no kind `sandbox`.
  The two tasks that fail in both arms (0/3 each) fail the same way with open reads. The blocked
  reads were `~/.garuda/models.json`, in a task that also fails with it readable.

## Measurement, the other suites (2026-11-10, macOS, Haiku 5.5, `--repeat 3 --parallel 4`)

| Suite | open | needed | B − A (95% interval) |
| --- | --- | --- | --- |
| `basic` | 30/30 | 30/30 | 0 |
| `hard` | 18/18 | 18/18 | 0 |
| `medium` | 29/30 | 21/30 | −27 pts (−53 to 0) |
| `python` | 15/15 | 0/15 | all fail |
| `java` | 15/15 | 15/15 | 0 |

- Every failure in "needed" mode was the check's "No module named pytest". The Mac's `python3` is
  the Command Line Tools Python, and `pip install --user` puts pytest in
  `~/Library/Python/<version>/lib/python/site-packages`. The fixed list had the Linux user folder
  (`.local/lib`), not the macOS one. Python skips a user folder it cannot read with no error, so
  no run got the kind `sandbox`. The `medium` suite's Python tasks failed the same way.
- Fix: `Library/Python` joins the fixed list, and with it pipx's venvs (`.local/pipx`,
  `.local/share/pipx`), which the links in `~/.local/bin` point to.
- The `python` and `medium` pairs are to be repeated with the fix. `basic`, `hard` and `java` meet
  the acceptance rule.
- A lesson for the default: a blocked read can fail silently. The paired measurement found both
  gaps (Vitest's token, the macOS user site); neither gave a read error.
