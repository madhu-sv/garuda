# Hooks (`src/hooks/`)

## Purpose

Run the user's own commands before and after tool calls: guards that block calls, and checks that give
the model feedback (for example lint errors). Hooks can block; they can never approve.

## Config (`config.ts`)

`~/.garuda/hooks.json` (user, trusted) and `<root>/.garuda/hooks.json` (project, needs consent):

```json
{ "hooks": {
  "preToolUse":  [{ "tools": ["bash(git push*)"], "command": "echo 'Pushes need a review.' >&2; exit 2" }],
  "postToolUse": [{ "tools": ["edit_file", "write_file"], "command": "npx eslint \"$GARUDA_FILE\" >&2 || exit 2",
                    "timeoutMs": 30000, "network": false }]
} }
```

- Strict schema; events: `preToolUse`, `postToolUse`.
- `tools`: permission rule syntax; empty = every tool. Invalid rules are reported and the hook is skipped.
- `hooksHash(project hooks)`: sha256 of the canonical list; consent is pinned to it in `trust.json`
  (`hooks: { <root>: <hash> }`).

## Consent (runtime, before the first turn)

User hooks are active at once. Project hooks: if the stored hash differs, Garuda asks "Run this project's
hooks?" and shows every event, tool list, network flag and command in full, and whether an OS sandbox
exists. Answers: once, remember (store the hash), deny (ignore the project's hooks). A changed file asks
again ("changed since you allowed them").

## Runner (`runner.ts`)

`HookRunner` implements `ToolHooks`; the registry calls it around each tool call.

| Event | When | Exit 0 | Exit 2 | Other exit, timeout, crash |
| --- | --- | --- | --- | --- |
| `preToolUse` | After `describe()`, before the permission check | continue | block; stderr is the reason for the model | block (fail closed) + warning for the user |
| `postToolUse` | After the call | nothing | append `<hook_feedback>stderr</hook_feedback>` to the result | warning only |

Matching: a hook applies when one of its rules matches the call (deny-mode matching, so for commands one
matching part is enough: `git status && git push` matches `bash(git push*)`).

Execution:

- `executor.run(command, policy, { signal, env })` with `policy = execPolicy(timeoutMs, { sandbox: true })`,
  `network` from the hook, output capped at 8 000 bytes.
- Data: a 0600 temp file (`$GARUDA_HOOK_INPUT`) with `{ event, tool, input, target, result?, root }`,
  deleted afterwards; variables `$GARUDA_HOOK_EVENT`, `$GARUDA_TOOL`, `$GARUDA_FILE` (absolute, for path
  targets), `$GARUDA_COMMAND`, `$GARUDA_URL`.
- Hook output is cleaned, capped at 4 000 characters, and tags are neutralized.

## Other parts

`/hooks` lists the active hooks. The system prompt explains "Blocked by a hook" and `<hook_feedback>` when
hooks exist. The evals run with `hooks: false`.

## Tests

`test/hooks.test.ts`: config and hashing, block with exit 2 before the approval, fail closed on exit 1 and
on a timeout, event data in the file and variables, post-hook feedback and warnings, and project consent
(deny, remember, pinned, changed).
