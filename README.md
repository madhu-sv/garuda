# Garuda

Garuda is a terminal coding agent. This is version 0.1.
The requirements doc defines the scope. Code, tests and commits refer to its IDs (F1–F26, N1–N8).

## Status

| Milestone | State |
| --- | --- |
| M1 Skeleton and fake model | Done |
| M2 Read-only tools | Done |
| M3 Write tools and permissions | Done |
| M4 Limits, context, sessions | Done |
| M5 CLI polish and evals | Done |

## Use

You need Node 22 or later and pnpm 10. Node 25 and later do not include corepack, so install pnpm with npm:

```sh
npm install -g pnpm@10
pnpm install
pnpm check          # typecheck + lint + tests
pnpm build
export ANTHROPIC_API_KEY=...
export GARUDA_MODEL=<model-id>
node dist/cli/index.js                                  # chat in the current folder
node dist/cli/index.js -p "Explain what this repo does" # run one task and exit
echo "Explain this repo" | node dist/cli/index.js       # the same, from stdin
```

Tools: read_file, glob and grep run with no question.
write_file, edit_file and bash show a diff or the command first. You pick: allow once, allow for this session, or deny.
Commands run on your machine with no sandbox in 0.1, so read each one before you allow it.

Try it on this repo:

```sh
node dist/cli/index.js -p "Where is runAgent defined, and what does it do?"
node dist/cli/index.js -p "Run the tests and tell me the result"
```

## Chat mode

`garuda` with no task starts a chat. Each line is one task; the conversation carries over.

- `/help`, `/usage` (tokens and cost), `/session` (id and file), `/new` (new session), `/exit`.
- Ctrl-C during a task stops the task and kills its commands. The chat goes on.
  A second Ctrl-C during the task exits Garuda at once.
- At the prompt, Ctrl-C twice (within 2 s) or Ctrl-D exits.
- Files are written atomically (a temporary file, then a rename), so an exit never leaves half a file.
- `garuda --resume` continues the latest session in chat mode.

Model text goes to stdout; tool activity and notes go to stderr. So `garuda -p "…" > answer.md` keeps only the answer.

## Evals

`garuda eval` runs eval tasks in scratch folders and reports pass or fail, steps, tokens and cost per task (N5).
A task passes when its check command exits with 0 and the agent did not change the task's tests.
The 0.1 target is 7 of 10.

```sh
garuda eval --list                         # the tasks of each suite
garuda eval -m claude-sonnet-5             # the basic suite (10 small repos)
garuda eval -s hard                        # the hard suite (6 tasks on a 110-file repo)
garuda eval -t fix-add hard-rename --keep  # some tasks, keep the scratch folders
```

The runner approves every call except its deny rules (`rm -rf`, `sudo`, `git push`, `curl`, `wget`).
Commands run on your machine, in the scratch folders, with no sandbox. Results and session files go to
`.garuda/evals/<run-id>/`.

`pnpm startup` checks that startup takes less than 1 s (N3). The Anthropic SDK and the prompt library
load on first use, not at startup.

## Sessions, limits and context

Every run writes a session file: `.garuda/sessions/<id>.jsonl` (one JSON record per line, mode 0600).
It holds every message, tool call, result, token count and cost. Garuda redacts known secret
formats (API keys, tokens, private keys, `password=…`) and the values of secret-looking environment
variables before it writes a line. The model can still see a secret; the file never holds it.

```sh
garuda -p "Find the flaky test"                 # new session
garuda --resume -p "Now fix it"                 # continue the latest session
garuda --resume 20260923-201500-a1b2 -p "…"     # continue a given session
garuda --replay 20260923-201500-a1b2            # replay it: no API calls, no tools run
```

- After each turn Garuda prints steps, tokens (with cache reads), cost, context use and the session total.
- A run stops at 50 steps, at the session token budget (20M tokens), or after the same tool call
  3 times in a row. Garuda says why.
- At 80% of the context window, Garuda first cuts long tool outputs in older turns. If that is not enough,
  the model summarises the older turns. The last 4 turns always stay in full.
- `GARUDA.md` in the project root goes into the system prompt.
- Project memory: the `remember` tool saves lasting facts (build and test commands, layout, conventions)
  to `.garuda/memory.md`, with your approval. The next session loads them after `GARUDA.md`.
  Edit or delete lines freely. Add `remember` to `permissions.allow` to skip the question.
- `read_file` does not send the same lines of an unchanged file twice. After compaction it sends them again.
- Garuda knows the price and context window of current Claude models. For other models, set them in settings.

## Permissions

Put rules in `.garuda/settings.json` in the project. Deny rules always win.

```json
{
  "executor": "host",
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
  A deny rule blocks the command when one part matches. An allow rule must match every part.
- Sensitive files (`.env*`, keys, `.npmrc`, `.aws/`, …) are blocked, also for reads.
  An allow rule that names the file, for example `read_file(.env.example)`, unblocks it.
- Write tools never change files in `.git/`.
- Commands see only these environment variables: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`,
  `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TZ`, plus the names in `env.allow`. API keys stay out.
- With no terminal on stdin (a pipe or CI), Garuda cannot ask, so it denies calls that need approval.

## Standalone binary

`pnpm package` builds one executable file, `bin/garuda`, for the machine you build on.
It holds Node and all of Garuda, so the target machine does not need Node.
It needs Node 25.5 or later to build (it uses `node --build-sea`).

```sh
pnpm package
./bin/garuda                 # greeting
./bin/garuda --version
sudo cp bin/garuda /usr/local/bin/   # optional: put it on your PATH
```

Notes:

- The binary is about 100–150 MB, because it contains the Node runtime.
- Build on each platform that you want to run on. A binary built on an Apple silicon Mac runs only on Apple silicon Macs.
- On macOS, the script signs the binary ad hoc (`codesign --sign -`), so it runs on the machine that built it.
- Homebrew's Node has single executables turned off. The script then downloads the official Node build of
  the same version from nodejs.org, checks its SHA-256 sum and keeps it in `~/.cache/garuda`.
  Set `GARUDA_SEA_NODE=/path/to/node` to use a Node binary of your choice, or `NODEJS_ORG_MIRROR` to use a mirror.

## Layout

| Folder | Holds |
| --- | --- |
| `src/model/` | Provider-neutral types, `ModelClient`, the Anthropic adapter, the fake model |
| `src/loop/` | `runAgent(session, deps)`: the agent loop, limits, loop guard; `replaySession` |
| `src/context/` | Compaction and the GARUDA.md loader |
| `src/tools/` | `Tool<I, O>`, the registry, and the tools: `read_file`, `glob`, `grep`, `write_file`, `edit_file`, `bash` |
| `src/permissions/` | Path guard (F15), rules, sensitive paths, settings, and the permission engine (F17–F20) |
| `src/sandbox/` | `Executor` interface, `ExecPolicy`, `HostExecutor`. The only place that starts processes (N8) |
| `src/session/` | Session state, records, `SessionStore` (JSONL files), resume, redaction, read tracking |
| `src/app/` | `Runtime`: settings, executor, permissions and session for one process. The CLI and the evals share it |
| `src/cli/` | Entry point, chat mode, renderer, terminal approver, `garuda eval` |
| `src/evals/` | The 10 eval tasks and the runner |
| `scripts/` | Build helpers. `package.mjs` makes the standalone binary |
| `test/` | Vitest suites. `loop.test.ts`, `m2.acceptance.test.ts` and `m3.acceptance.test.ts`, `m4.acceptance.test.ts`, `m5.acceptance.test.ts` hold the milestone acceptance tests. `executorContract.ts` is the suite every executor must pass |

## Rules

- The loop gets all dependencies as arguments. It never imports the CLI.
- Only `src/model/anthropic.ts` imports the Anthropic SDK (N1).
- Only `src/sandbox/` may start processes (N8). Biome and a test enforce this.
- Strict TypeScript. No `any` in public interfaces (N7).
