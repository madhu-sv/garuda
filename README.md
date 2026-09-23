# Garuda

Garuda is a terminal coding agent. Version 0.1 is in progress.
The requirements doc defines the scope. Code, tests and commits refer to its IDs (F1–F26, N1–N8).

## Status

| Milestone | State |
| --- | --- |
| M1 Skeleton and fake model | Done |
| M2 Read-only tools | Done |
| M3 Write tools and permissions | Next |
| M4 Limits, context, sessions | — |
| M5 CLI polish and evals | — |

## Use

You need Node 22 or later and pnpm 10. Node 25 and later do not include corepack, so install pnpm with npm:

```sh
npm install -g pnpm@10
pnpm install
pnpm check          # typecheck + lint + tests
pnpm build
export ANTHROPIC_API_KEY=...
export GARUDA_MODEL=<model-id>
node dist/cli/index.js                                  # prints a greeting
node dist/cli/index.js -p "Explain what this repo does" # runs one task
```

Garuda can read and search code (read_file, glob, grep). It cannot change files yet. M3 adds that.

Try it on this repo:

```sh
node dist/cli/index.js -p "Where is runAgent defined, and what does it do?"
```

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
| `src/loop/` | `runAgent(session, deps)`: the agent loop |
| `src/tools/` | `Tool<I, O>`, the registry, and the tools: `read_file`, `glob`, `grep` |
| `src/permissions/` | Path guard: tools accept only paths inside the working root (F15) |
| `src/session/` | In-memory session state |
| `src/cli/` | Entry point: greeting, and one-shot mode with `-p` |
| `scripts/` | Build helpers. `package.mjs` makes the standalone binary |
| `test/` | Vitest suites. `loop.test.ts` and `m2.acceptance.test.ts` hold the milestone acceptance tests |

## Rules

- The loop gets all dependencies as arguments. It never imports the CLI.
- Only `src/model/anthropic.ts` imports the Anthropic SDK (N1).
- Only `src/sandbox/` may start processes (N8). Biome and a test enforce this.
- Strict TypeScript. No `any` in public interfaces (N7).
