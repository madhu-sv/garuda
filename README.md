# agent-harness

A terminal coding agent. Version 0.1 is in progress.
The requirements doc defines the scope. Code, tests and commits refer to its IDs (F1–F26, N1–N8).

## Status

| Milestone | State |
| --- | --- |
| M1 Skeleton and fake model | Done |
| M2 Read-only tools | Next |
| M3 Write tools and permissions | — |
| M4 Limits, context, sessions | — |
| M5 CLI polish and evals | — |

## Use

```sh
pnpm install
pnpm check          # typecheck + lint + tests
pnpm build
export ANTHROPIC_API_KEY=...
node dist/cli/index.js -p "Explain what this repo does" --model <model-id>
```

M1 has no tools yet, so the agent can only talk. M2 adds the read-only tools.

## Layout

| Folder | Holds |
| --- | --- |
| `src/model/` | Provider-neutral types, `ModelClient`, the Anthropic adapter, the fake model |
| `src/loop/` | `runAgent(session, deps)`: the agent loop |
| `src/tools/` | `Tool<I, O>` and the registry (validation, error results) |
| `src/session/` | In-memory session state |
| `src/cli/` | Entry point (one-shot mode only in M1) |
| `test/` | Vitest suites. `loop.test.ts` holds the M1 acceptance test |

## Rules

- The loop gets all dependencies as arguments. It never imports the CLI.
- Only `src/model/anthropic.ts` imports the Anthropic SDK (N1).
- Only `src/sandbox/` may start processes (N8). Biome and a test enforce this.
- Strict TypeScript. No `any` in public interfaces (N7).
