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
  execPolicy(timeoutMs, { sandbox? }): ExecPolicy;
}
type PermissionDecision =
  | { allowed: true; by: "read_only" | "sandbox" | "rule" | "session" | "user" }
  | { allowed: false; by: "rule" | "sensitive" | "user"; reason };

interface Approver { ask(request: ApprovalRequest, signal): Promise<"once" | "session" | "deny"> }
interface ApprovalRequest { tool; target; preview; isolation; title?; labels? }
```

Approvers: `TerminalApprover` (inquirer), `ChatStore` (Ink), `AutoApprover` (tests, evals),
`SwitchApprover` (swaps to the Ink chat when it starts).

## Engine (`engine.ts`)

Order of checks — the first match decides:

| # | Check | Result |
| --- | --- | --- |
| 1 | Path target is sensitive and no allow rule *with a pattern* names it (F20) | deny |
| 2 | A write to a path inside `.git/` | deny |
| 3 | A deny rule matches (F19) | deny |
| 4 | Read-only tool (F17) | allow |
| 5 | Command target, not `outsideSandbox`, and the executor has isolation | allow (`sandbox`) |
| 6 | An allow rule or a session rule matches, and the target is not an `alwaysAsk` URL | allow |
| 7 | Otherwise | ask the user (F18) |

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
  "web": { "enabled": true, "allowLocalhost": false },
  "limits": { "maxSteps": 50, "tokenBudget": 20000000 },
  "model": { "contextWindow": 200000, "price": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 } }
}
```

A missing file gives the defaults; a broken file is an error that names the file.

## Path guard (`pathGuard.ts`)

`resolveInRoot(root, input)` resolves a relative or absolute path and checks it twice: as written, and as
a real path (the existing part through `realpath`, the rest added back). So a symbolic link cannot lead
outside the root. It throws `PathOutsideRootError`. `displayPath` gives the root-relative form.

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
| Unreadable | `~/.ssh`, `~/.aws`, `~/.azure`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config/gcloud`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/Library/Keychains`, plus `sandbox.denyRead` |

`~/` means the home folder; other relative paths start at the root.

## Tests

`test/permissions.test.ts`, `test/pathGuard.test.ts`, `test/sandbox.test.ts` (engine with an OS
sandbox), `test/webFetch.test.ts` (URL rules), `test/mcp.test.ts` (MCP rules).
