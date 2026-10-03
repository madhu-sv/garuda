# Permissions (`src/permissions/`)

## Purpose

Decide for each tool call: allow, deny, or ask the user (F17–F20). Build the execution policy for
commands (N8). Keep every file tool inside the working root (F15).

## Types (`types.ts`)

```ts
type CallTarget =
  | { kind: "path"; path }                          // relative to the root
  | { kind: "command"; command; outsideSandbox? }
  | { kind: "url"; url; host; alwaysAsk? }
  | { kind: "input"; json };                         // tools with no specific target

interface PermissionGate {
  check(request: { tool; readOnly; info?: { target; preview? } }, signal): Promise<PermissionDecision>;
  execPolicy(timeoutMs, { sandbox?, readOnlyRoot? }): ExecPolicy;
}
type PermissionDecision =
  | { allowed: true; by: "read_only" | "sandbox" | "rule" | "session" | "user" }
  | { allowed: false; by: "rule" | "sensitive" | "user" | "unattended" | "policy"; reason };

interface Approver { ask(request: ApprovalRequest, signal): Promise<"once" | "session" | "deny"> }
interface ApprovalRequest { tool; target; preview; isolation; title?; question?; choices?; labels? }
```

`question` replaces "Allow?" above the choices; `choices` shows a subset (for example yes or no, with no
"session" choice).

Approvers: `TerminalApprover` (inquirer), `ChatStore` (Ink), `AutoApprover` (tests, evals),
`SwitchApprover` (swaps to the Ink chat when it starts).

## Engine (`engine.ts`)

The team policy (`src/permissions/policy.ts`): `loadTeamPolicy({ home?, managed? })` reads the managed
file (`managedPolicyPath`) and `~/.garuda/policy.json` and merges them with `mergePolicies` (the stricter
value wins). Only the CLI calls it (chat, `-p`, `garuda run`, `garuda eval`); the runtime takes the result
as `options.policy` and never reads `<root>/.garuda/policy.json` (`ignoredProjectPolicy` gives a notice).
A broken file is an error that names it.

Order of checks — the first match decides:

| # | Check | Result |
| --- | --- | --- |
| 0 | Team Policy violation (the managed file and `~/.garuda/policy.json`, never the project's: disallowed commands, require sandbox, deny paths, blocked hosts, strict allowlist) (0.17). With `requireSandbox`, isolation `none` counts as outside the sandbox, so every command is denied (G03). | deny (`by: "policy"`) |
| 1 | Path target is sensitive and no allow rule *with a pattern* names it (F20) | deny |
| 2 | A write to a path inside `.git/` | deny |
| 3 | A deny rule matches (F19) | deny |
| 3b | Plan mode (0.4) and the tool is not read-only | see below; never asks |
| 4 | Read-only tool (F17) | allow |
| 5 | Command target, not `outsideSandbox`, and the executor has isolation | allow (`sandbox`) |
| 6 | An allow rule or a session rule matches, and the target is not an `alwaysAsk` URL | allow |
| 7 | Otherwise | ask the user (F18) |

Every permission check, and every tool run of the main agent, goes to the audit log by `AuditLogger`
(0.17): `~/.garuda/audit/<project>-<hash>/<time>-<pid>-<random>.jsonl` (`auditDirFor`), one file per
process, written in order (a queue), targets and reasons redacted, each line chained by `seq`, `prev`
and `hash`; `verifyAuditFile` checks a file. The runtime writes it only when the caller passes
`audit: { dir }` (the CLI does); a write failure is an error when the policy sets `audit.enabled:
true`, else one notice. Inspect with `/audit`, `/audit verify`.

### Plan mode (0.4)

Unattended (0.7, scheduled jobs): with the option `unattended: { reason, onDeny }`, step 7 never asks: the
call is denied (`by: "unattended"`) with the reason (`JOB_DENIAL`), and `onDeny` records it for the job
report. The job's rules come in `settings.allow`. See [jobs.md](jobs.md).

The engine gets the mode of the current turn (`mode: () => AgentMode`). In plan mode a call that is not
read-only is decided by `planDecision`, and the user is never asked:

| Call | Plan mode |
| --- | --- |
| Command target, in the OS sandbox | allow (`sandbox`) |
| Command outside the sandbox, or no OS sandbox | deny |
| Path target (write_file, edit_file) or `remember` | deny, even with an allow rule |
| Other targets (web_fetch, MCP tools) | allow only with an allow rule; an `alwaysAsk` URL is denied |

The denial text is `PLAN_MODE_DENIAL`: it tells the model to put the change in its plan. Read-only tools
(read_file, glob, grep, explore, todo_write, the code index) run as in build mode; sensitive files and
deny rules still apply first.

`execPolicy` in plan mode (`readOnlyRoot`, default: true in plan mode) removes the root and every path inside it from the write paths, and adds the
root as the first read-only path (for a project inside a writable folder such as a temp dir). Commands
can still write temp folders and package caches, so tests that write nothing in the project run.
Hooks use the same policy.

"Session" answers add a session rule:

| Target | Session rule |
| --- | --- |
| command | exactly this command (`exact: true`); `ls` must not allow `ls; rm -rf .` |
| url | this host only |
| path, input | all calls of this tool |

`execPolicy(timeoutMs, { sandbox = true })` builds the `ExecPolicy`: root, `sandbox`, write paths,
protected paths and denied read paths from `sandboxPaths()`, `network: !sandbox`, the environment
allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`,
`TZ` plus `env.allow` from settings), the timeout and a 30 000-byte output cap per stream.

`serverPolicy()` (0.4) is the policy for language servers: `execPolicy(0, { readOnlyRoot: true })` with
no output cap. So a server runs in the sandbox, cannot write the project, and has no network. See
[lsp.md](lsp.md).

The engine option `access` (0.3) adds the language profiles' package caches to the write paths and their
variables (for example `JAVA_HOME`) to the environment list. See [languages.md](languages.md).

## Rules (`rules.ts`)

Syntax: `tool` or `tool(pattern)`. The tool name may end with `*` (prefix match, for MCP servers) and may
contain `-`.

| Target | Pattern meaning | Example |
| --- | --- | --- |
| path | Glob relative to the root. A pattern without `/` matches at any depth. `**`, `*`, `?`. | `edit_file(src/**)`, `read_file(.env.example)` |
| command | `*` matches any text. The command is split at `;`, `&&`, `\|\|`, `\|` and `$(…)`. An allow rule must match every part; a deny rule needs one part (or the whole command). | `bash(pnpm test*)`, `bash(rm -rf*)` |
| url | A host; `*.example.com` matches subdomains only. | `web_fetch(docs.python.org)` |
| input (web_search, 0.5) | Only the bare tool rule: it allows every search. | `web_search` |

A tool's `CallInfo` may carry a `title` (0.5): the engine passes it to the approver as the question's header
(web_search: "web_search wants to search the web:").
| input | Only bare tool rules match. | `mcp__github__get_issue`, `mcp__github__*` |

## Settings (`settings.ts`)

`.garuda/settings.json`, strict Zod schema (unknown keys are errors):

```json
{
  "executor": "auto",
  "sandbox": { "writePaths": ["~/tools/cache"], "denyRead": ["~/secrets"] },
  "codeIndex": "off",
  "permissions": { "allow": ["bash(pnpm test*)"], "deny": ["bash(git push*)"] },
  "env": { "allow": ["NODE_ENV"] },
  "network": { "allow": ["npm", "pypi", "api.example.com"] },
  "web": { "enabled": true, "allowLocalhost": false },
  "subagents": { "enabled": true, "maxSteps": 20, "tokenBudget": 150000 },
  "moe": { "enabled": false },
  "daemons": { "enabled": false },
  "todo": { "enabled": true },
  "lsp": { "enabled": true },
  "undo": { "enabled": false },
  "skills": { "enabled": false },
  "agents": { "enabled": false },
  "notifications": { "channel": "auto", "afterSeconds": 10 },
  "formatters": { "enabled": true, "commands": { "prettier": false } },
  "thinking": { "keepBlocks": true, "enabled": true, "effort": "low", "show": false },
  "limits": { "maxSteps": 50, "tokenBudget": 20000000 },
  "model": { "contextWindow": 200000, "price": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 } }
}
```

A missing file gives the defaults; a broken file is an error that names the file.

Project settings consent (`projectSettings.ts`, review 2026-10): `settingsRisk` lists the parts that
loosen safety (executor host, allow rules, `sandbox.writePaths`, `env.allow`, `web.allowLocalhost`);
`gateProjectSettings` applies them when their hash is pinned in `trust.json` (`settings`, per root) or
the user says yes at startup (`RuntimeOptions.projectSettings.ask`; "remember" pins), and otherwise
returns `withoutRisk(settings)` and a notice. `Runtime.create` gates the loaded file (not
`options.settings`: evals and jobs pass their own); without `projectSettings` nothing is pinned and
nobody is asked. Allow rules match command parts as written (`commandParts(command, false)`); deny
rules and the team policy still strip `sudo`, `env`, `exec`, `command` and `VAR=value`.

`moe` and `daemons` (0.14–0.17) are off by default, like every feature with no measured gain.
`subagents.enabled` does not turn MoE on.

`network.allow` (0.13): presets (`NETWORK_PRESETS` in `src/net/allowlist.ts`) or host patterns; any other
entry is an error. The engine's `setNetwork(handle)` adds `proxy` to sandboxed command policies (not to
`serverPolicy`), and `takeNetworkBlocks()` returns the hosts the proxy blocked. A host outside the list is
checked as tool `network` with a URL target, so `network(host)` rules and session answers work as for
web_fetch.

## Path guard (`pathGuard.ts`)

`resolveInRoot(root, input)` resolves a relative or absolute path and checks it twice: as written, and as
a real path (the existing part through `realpath`, the rest added back). So a symbolic link cannot lead
outside the root. It throws `PathOutsideRootError`. `displayPath` gives the root-relative form.
`realRelative(root, path)` (0130) gives the root-relative real path when a link makes it another
path in the root; the engine runs the path denials (`pathDenial`: team policy, sensitive files,
`.git`, deny rules) on it too, and `grep` checks the target of each link it meets (and skips a link
out of the root). Path patterns ignore letter case on macOS and Windows (`CASE_INSENSITIVE_FS`).

## Sensitive files (`sensitive.ts`)

`SENSITIVE_PATTERNS`: `.env`, `.env.*`, `.envrc`, `**/.ssh/**`, `**/.aws/**`, `**/.gnupg/**`, Docker and
kube configs, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, credentials files, `*.pem`, `*.key`,
`*.p12`, `*.pfx` and others. File tools refuse them (also for reads) unless an allow rule names the file.
grep never searches them; the code index never indexes them.

## Sandbox paths (`sandboxPaths.ts`)

| List | Default |
| --- | --- |
| Writable | the root, `os.tmpdir()` and `/tmp` (real paths), `~/.cache`, `~/.npm`, `~/.local/share/pnpm`, `~/Library/Caches`, `~/Library/pnpm`, plus `sandbox.writePaths`, plus the caches of the detected language profiles (for example `~/.m2/repository`) |
| Read-only inside the root | `.git/hooks`, `.git/config`, `.garuda` (they run or apply later, outside the sandbox) |
| Unreadable | `~/.ssh`, `~/.aws`, `~/.azure`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config/gcloud`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/Library/Keychains`, `~/.garuda/mcp-auth.json`, `~/.claude.json`, `~/.claude/.credentials.json` (0.5: tokens of Garuda and Claude Code; the rest of `~/.garuda` and `~/.claude` stays readable, for skills), plus `sandbox.denyRead` |

`~/` means the home folder; other relative paths start at the root.

The team policy's `denyPaths` (0130, K6): `execPolicy` adds `policyDeniedPaths(root, denyPaths)` to
both `denyReadPaths` and `denyWritePaths`. The patterns are matched against the disk when a command
starts (globby, no .gitignore, not in `node_modules` or `.git`, at most 1,000 paths), because the
OS sandboxes need real paths.

## Tests

`test/permissions.test.ts`, `test/pathGuard.test.ts`, `test/sandbox.test.ts` (engine with an OS
sandbox), `test/webFetch.test.ts` (URL rules), `test/mcp.test.ts` (MCP rules).
