# Reads only where needed (T15): design

Status: proposed (2026-11-09). Nothing here is built yet. The user decides the open questions at
the end, and the default after the measurement.

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
  strict profile does not imply it (decide: open question 1).

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
| Python | `.pyenv`, `.local/lib`, `.local/share/uv`, `.cache/uv`, `.cache/pip`, `Library/Caches/pip`, `.cache/pypoetry`, `Library/Caches/pypoetry`, `.virtualenvs`, `.conda`, `miniconda3`, `miniforge3`, `anaconda3` |
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

Two gaps exist in both modes today. They need a fix whatever the user decides about T15.

**The macOS keychain.** Garuda denies the keychain files (`~/Library/Keychains`), but a command
does not need them: `security find-generic-password -s <service> -w` asks the `securityd`
service, and the profile allows every Mach service. A keychain item that the `security` tool
created can trust that tool, so macOS may answer with no question. Command-line tools keep tokens
this way; the GitHub CLI is one. The fix: deny the lookup of the security services in the profile
(`(deny mach-lookup (global-name "com.apple.SecurityServer") …)`; the exact names come from the
probe below). Cost to check: `xcodebuild` signs builds for a device with a keychain identity, and
git's `osxkeychain` helper stops. Simulator builds use an ad-hoc signature and need no keychain.

**The Linux session bus.** `secret-tool lookup …` asks the Secret Service on the session bus,
whose socket is `/run/user/<uid>/bus`. bubblewrap's `--unshare-net` does not cover a socket in the
file system. The fix: an empty tmpfs over `/run/user/<uid>` (both modes). Cost: nothing that a
build needs uses the session bus.

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

The first three join `DENY_READ_IN_HOME` in both modes. The last four are open question 3.

**The probe for the keychain** (on the Mac; it uses a test item, not a real secret):

```sh
security add-generic-password -s garuda-probe -a probe -w not-a-secret
g -p 'Run this command and show its output: security find-generic-password -s garuda-probe -w'
security delete-generic-password -s garuda-probe
```

If the output shows `not-a-secret`, the gap is real, and the fix goes in a patch before T15.

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

## Open questions for the user

1. Should the strict profile imply `"needed"`? (Proposal: yes, once the measurement passes.)
2. The chat question for a blocked read, or only the note? (Proposal: both, as for the network.)
3. The mixed credential files (`.m2/settings.xml`, `.gradle/gradle.properties`, `.yarnrc.yml`,
   `NuGet.Config`): deny them in `"needed"` mode with a note that names `readPaths`, or keep them
   readable? (Proposal: deny; a build that needs one fails with a clear note.)
4. The keychain fix: deny the security services in both modes, even though device builds with
   `xcodebuild` then need `outside_sandbox`? (Proposal: yes; ad-hoc and simulator builds work.)

## Plan

1. The probe; then the non-file secrets fix (keychain lookup, session bus, the three publish-only
   credential files), in both modes. A patch release, because it is a security fix.
2. `sandbox.reads` and `sandbox.readPaths`, the macOS and Linux rules, and tests that run real
   commands in the sandbox on each system (a denied read, a readable toolchain, the metadata rule).
3. The blocked-read note, the chat question and the `sandbox` failure kind.
4. Repo-task evals on the mode.
5. The measurement; the results go in this note; the user decides the default.
