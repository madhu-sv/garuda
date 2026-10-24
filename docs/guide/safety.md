# Sandbox, permissions and policy

The OS sandbox, the network allowlist, staged commands, permissions, hooks, the team policy and the audit log.

## Sandbox

Garuda runs commands in an OS sandbox: Seatbelt (`sandbox-exec`) on macOS, bubblewrap (`bwrap`) on Linux.
In the sandbox, a command:

- can read every file, except secrets in your home folder (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`,
  `~/.docker`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials`, keychains, Garuda's and Claude Code's tokens and more);
- can write only in the working root, the temp folders and package caches (`~/.cache`, `~/.npm`, pnpm,
  and for a Java or Python project `~/.m2/repository`, `~/.gradle/caches` and similar);
- cannot write `.git/hooks`, `.git/config` or `.garuda/` in the root, because those run or apply later
  outside the sandbox;
- has no network (localhost works on macOS), unless you open a network allowlist (0.13, below);
- cannot start apps on macOS (`open`, `osascript`), because an app started that way runs outside the
  sandbox (0.14);
- sees only its own processes on Linux, not Garuda's or yours (0.14);
- does not outlive the call (a daemon, below, is the exception you ask for): Garuda stops the
  command's processes when it ends, also ones that left its process group (on macOS since 0.17,
  with the helper `garuda-reap` that the npm package holds; without it Garuda warns, and the strict
  profile refuses sandboxed commands).

Commands in the sandbox run with no approval. Deny rules still apply. When the sandbox blocks a command
(for example `pnpm install` needs the network), the model can ask to run it outside the sandbox.
That asks you first, unless one of your allow rules covers the command, and the prompt says
"OUTSIDE the sandbox". The strict profile forbids it.

Settings:

```json
{
  "executor": "auto",
  "sandbox": { "writePaths": ["~/tools/cache"], "denyRead": ["~/work-secrets"] }
}
```

- `executor`: `auto` (default) uses the sandbox when it works on this machine, else runs on the host
  with a notice. `os` requires the sandbox. `host` turns it off, and every command asks again (unless an allow rule covers it).
- `sandbox.writePaths` and `sandbox.denyRead` add paths. `~/` is the home folder; other relative paths
  start at the root.
- macOS sandbox probe (0.14): at startup Garuda runs `true` through `/usr/bin/sandbox-exec` once. When
  that fails (for example in a nested sandbox), `auto` falls back to the host with a notice that gives
  the first line of the error.
- On Linux, install bubblewrap (`sudo apt install bubblewrap`). Some systems block the user namespaces
  that it needs; Garuda then falls back to the host and says why.

### Staged commands (0.17, off by default)

With `"commands": { "mode": "staged" }` in `.garuda/settings.json`, a command in the sandbox cannot
change your project without your answer:

- At the session start, Garuda makes a staging copy of the project in `~/.garuda/staging/` (a clone on
  APFS, a reflink on Btrfs or XFS, else a plain copy of at most 2 GB). It is removed at the end.
- Each sandboxed command runs in the copy. On Linux the copy is mounted at the project's path; on macOS
  the command runs at the copy's path, and the project is read-only for it.
- After the command, Garuda lists what changed. No change that git tracks: no question. A change: the
  question shows the files and the diff, and you apply or discard. Apply copies the files into the
  project (all or nothing; `/undo` takes them back). The model gets a note with your answer.
- Files that `.gitignore` covers (build output, `node_modules`) stay in the copy for the next commands
  and are never applied. Changes in `.git` are not applied either. The question counts them per
  folder and names sensitive ones (for example `.env`).
- A file that you changed in the project during the command is a conflict: nothing is applied. A link
  that points out of the project is refused. A list that is not complete (more than 50,000 files) can
  only be discarded.
- No copy (no OS sandbox, a project over the limits): the session does not start. Garuda never runs
  the commands in direct mode instead.
- Not staged: `outside_sandbox: true` (it asks first, as before), MCP servers and language servers
  (long-running programs), and scheduled jobs (they have their own worktree). Background daemons are
  off in staged mode. A hook that writes files asks like a command.

### Network allowlist (0.13)

Installs and builds need a package registry, but not the whole internet. The allowlist lets commands in
the sandbox reach named hosts through Garuda's own proxy, with no question:

```json
{ "network": { "allow": ["npm", "pypi", "api.example.com", "*.example.org"] } }
```

- Presets: `npm`, `pypi`, `maven`, `go`, `cargo`, `github` (each names its registry hosts). A host with
  `*.` matches its subdomains. Only ports 80 and 443.
- Off by default. The first turn shows the list and asks; "remember" pins it to the list in
  `~/.garuda/trust.json`, so a changed list asks again. The model then gets a note that names the hosts,
  so it runs those commands in the sandbox and does not ask to leave it.
- A host that is not on the list asks you (once, this session, or no); `network(host)` in
  `permissions.allow` or `permissions.deny` answers for good. Jobs and evals deny it and say which host.
- Commands get `HTTP_PROXY` and `HTTPS_PROXY`: npm, pnpm, yarn, pip, cargo, go, git and curl use them;
  Node's `fetch` too (`NODE_USE_ENV_PROXY`, Node 24 or later); Maven and Gradle through `MAVEN_OPTS` and
  `GRADLE_OPTS`. A tool that ignores the proxy variables still has no network.
- The proxy does not read the traffic: for https it sees only the host name. A host must resolve to
  public addresses; the proxy connects to the address it checked.
- On Linux the proxy reaches bubblewrap's network namespace through a small bridge that runs with
  `node`; with no `node` on the PATH the allowlist stays off and Garuda says so.
- A job keeps the list that was in effect when you scheduled it (the approval shows it).
  `garuda eval --network npm,pypi` measures a suite with the list.
- Limit on Linux: a protected path that does not exist yet (for example `.git/hooks` in a folder with no
  `.git`) is not protected.

### Background daemons (0.14, off by default)

Dev servers and watchers can run in the background. This is off by default (no measured gain yet).
Turn it on with `"daemons": { "enabled": true }` in `.garuda/settings.json`.

- With the setting on, `bash` takes `is_daemon: true`: the command starts through the same executor
  (the same sandbox and approval as any command) and the tool returns at once with a `daemonId`.
- The `process_manager` tool has `list`, `status`, `logs` (`lines`, `stream`) and `kill` for daemons
  that Garuda started in this session. `list`, `status` and `logs` run without a question; `kill`
  asks (or follows a rule) and is refused in plan mode.
- Logs are kept in memory: the newest 2,000 lines per daemon, at most 4,000 characters per line, and
  `logs` returns at most 30,000 characters (the newest lines).
- When the session closes, Garuda stops every running daemon (SIGTERM to the process group, then
  SIGKILL).

## Permissions

Put rules in `.garuda/settings.json` in the project. Deny rules always win.

```json
{
  "executor": "auto",
  "permissions": {
    "allow": ["bash(pnpm test*)", "bash(git status)", "edit_file(src/**)"],
    "deny": ["bash(rm -rf*)", "bash(git push*)"]
  },
  "env": { "allow": ["NODE_ENV"] },
  "limits": { "maxSteps": 50, "tokenBudget": 20000000 },
  "model": {
    "contextWindow": 200000,
    "price": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
  }
}
```

- A rule is `tool` (every call) or `tool(pattern)`.
- File patterns are globs relative to the root. A name without `/` matches at any depth.
- Command patterns use `*` for any text. Garuda splits a command at `;`, `&&`, `||`, `|` and `$(…)`.
  A deny rule blocks the command when one part matches, also behind `sudo`, `env` or `VAR=value`.
  An allow rule must match every part as written: `bash(pnpm test*)` does not cover
  `NODE_OPTIONS=… pnpm test` or `sudo pnpm test`.
- Sensitive files (`.env*`, keys, `.npmrc`, `.aws/`, …) are blocked, also for reads, also through a
  symbolic link with another name. On macOS and Windows, path patterns ignore letter case
  (`.ENV` is `.env` there).
  An allow rule that names the file, for example `read_file(.env.example)`, unblocks it.
- Write tools never change files in `.git/`.
- Commands see only these environment variables: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`,
  `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TZ`, plus the names in `env.allow`. API keys stay out.
- With no terminal on stdin (a pipe or CI), Garuda cannot ask, so it denies calls that need approval.
- The project's file comes with the repository, so its parts that loosen safety need your yes first:
  `executor: "host"`, `permissions.allow`, `sandbox.writePaths`, `env.allow` and
  `web.allowLocalhost`. At startup the chat (and `-p` in a terminal) shows them and asks: yes for this
  run, yes and remember (pinned in `~/.garuda/trust.json`; a change asks again), or no. Without a yes,
  Garuda leaves those parts out and says so; the rest of the file (deny rules, limits, features)
  applies. A scheduled job uses them only when they are pinned. Settings that `garuda init` writes
  ask once at the next start too.

## Hooks

Hooks are your own commands that run around the agent's tool calls (0.2).

```json
{
  "hooks": {
    "preToolUse": [
      { "tools": ["bash(git push*)"], "command": "echo 'Pushes need a review first.' >&2; exit 2" }
    ],
    "postToolUse": [
      { "tools": ["edit_file", "write_file"], "command": "npx eslint \"$GARUDA_FILE\" >&2 || exit 2" }
    ]
  }
}
```

- Your own hooks go in `~/.garuda/hooks.json`. A project can add hooks in `.garuda/hooks.json`; Garuda
  shows every command and asks first, like for MCP servers. "Remember" pins the answer to a hash of
  the hooks; any change asks again.
- `tools` uses the permission rule syntax (`edit_file`, `bash(git push*)`, `mcp__github__*`).
  An empty list matches every tool. Keys: `command`, `tools`, `timeoutMs` (default 30000), `network`.
- `preToolUse` runs before the approval question. Exit 0 lets the call go on. Exit 2 blocks it, and
  stderr tells the model why. Any other failure (another exit code, a timeout) also blocks the call:
  a broken guard never lets a call through. A hook can block a call, never approve one.
- `postToolUse` runs after the call. Exit 2 adds stderr to the result as feedback for the model
  (for example lint errors). Other failures only show a warning.
- Hooks run in the OS sandbox, with no network unless `"network": true`. They get
  `$GARUDA_HOOK_EVENT`, `$GARUDA_TOOL`, `$GARUDA_FILE` (for file tools), `$GARUDA_COMMAND` (bash),
  `$GARUDA_URL` (web_fetch), and `$GARUDA_HOOK_INPUT`: a JSON file with the tool input (and the result
  for postToolUse).
- `/hooks` shows the active hooks. The evals run with no hooks.

## Team policy and structured audit log (0.17, W5)

A team policy sets limits that a project cannot loosen, and an audit log records the permission decisions:

- **Team policy**: guardrails that a project's settings cannot loosen. Garuda reads the managed file
  (`/Library/Application Support/Garuda/policy.json` on macOS, `/etc/garuda/policy.json` on Linux;
  an admin writes it) and `~/.garuda/policy.json`. Where both exist, the stricter value wins: lists of
  denials add up, `requireSandbox`, `strictAllowlist` and the strict `profile` are on when either sets them, limits take the
  lower value, and `allowedModels` and `audit` come from the managed file when it sets them. A broken
  file stops Garuda. A project's own `.garuda/policy.json` is ignored with a notice: a cloned repo
  could otherwise remove its own limits. The chat, `-p`, jobs, the night shift and `garuda eval` all
  use the policy. `/audit` names the files. The keys:
  - `disallowedCommands`: command patterns that are denied in every run (for example
    `["rm -rf *", "git push *--force*"]`). A compound command is denied when one of its parts matches.
  - `requireSandbox`: When `true`, no command runs outside the OS sandbox: `outside_sandbox` is
    denied, and on a machine with no OS sandbox every command is denied.
  - `profile` (0.17): `"strict"` requires the OS sandbox. Without one, Garuda stops at startup and
    runs no command on the host; `"executor": "host"` is an error; the `bash` tool has no
    `outside_sandbox`. Strict wins in a merge. A project's `.garuda/settings.json` can also set
    `"profile": "strict"`, but cannot turn off a policy's strict profile.
  - `denyPaths`: root-relative path patterns that the agent may not read or write (for example
    `["**/.env*", "secret/**"]`). File tools refuse them; `grep`, `glob` and the code index skip them
    (no content, no name). Commands in the OS sandbox cannot read or write them either: the matching
    files and folders are added to the sandbox profile when each command starts (every folder is
    searched, also `node_modules` and `.git`, so a large tree makes each command start slower). When the patterns match more than
    1,000 paths, commands do not run, with a message: Garuda never leaves a denied path without a
    rule. A symbolic link to a denied file is denied too.
  - `allowedModels`: Allowlist of LLM models permitted for use in the organization.
  - `network`: `blockedHosts` (`*.example.com` for subdomains) and `strictAllowlist`. A blocked host
    stays blocked for `web_fetch` and for sandboxed commands, also when the project's
    `network.allow` lists it.
  - `limits`: Global caps on `maxSteps` and `tokenBudget`. They hold for each subagent run too
    (explore, custom agents, MoE specialists), whatever the `subagents` or `moe` settings say (0.14).
- **Structured audit log** (`~/.garuda/audit/<project>-<hash>/`, one file per Garuda process): on in
  the chat, `-p` and jobs (a job writes under its main checkout's folder, so the log outlives the
  worktree); off in evals and tests; the team policy can turn it off (`audit.enabled: false`) or make it
  mandatory (`audit.enabled: true`: a failed write then fails the call with an error result, and
  says whether the call ran). Without a policy a failed write
  gives one notice. It is not in the project, so the agent's own tools cannot edit it. Targets and
  reasons pass the session redactor, so known secret formats (keys, tokens, `password=…`) are removed. Each line has `seq`,
  `prev` and `hash` (sha256): `/audit verify` shows a changed, removed or inserted line. With
  `"audit": { "checkpoint": true }` in the policy (0.17, off by default), Garuda also keeps each
  file's last `seq` and `hash` in `checkpoints/<file>.json`, and `/audit verify` then shows lines cut
  from the end of a file and a deleted file. This makes the log tamper-evident, not tamper-proof: a
  user (or a program that runs as the user) can rewrite a file and its checkpoint together.
  Sandboxed commands cannot write `~/.garuda`.
  Each line records:
  - Every authorization decision (`allow_readonly`, `allow_sandbox`, `deny_policy`, `deny_user`, etc.).
  - Security risk classification (`low`, `medium`, `high`, `critical`).
  - Tool execution duration in milliseconds and error status, also for the tool calls of a subagent
    (0.14).
  - Calls that a preToolUse hook blocked, and each hook command that ran (0.14). The team policy's
    `requireSandbox` and `disallowedCommands` hold for hook commands too.
- **Chat command**: `/audit` displays active policy rules and recent audit events. Use `/audit stats` for totals, `/audit denials` for security blocks, `/audit verify` to check the hash chains, or `/audit <n>` for recent events.
