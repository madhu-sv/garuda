# Contributing to Garuda

Thank you for your interest. This page says how to build Garuda, what a change needs, and how a pull
request gets reviewed. Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
To report a security problem, use [SECURITY.md](SECURITY.md), not a public issue.

## Before you start

- **A bug:** open an issue with the bug template. Give the version (`garuda --version`), the
  platform and the sandbox (`garuda` prints it at startup), the steps, and what you expected.
- **A feature or a larger change:** open an issue first and describe the problem. A short
  discussion saves work on both sides. Small fixes (a typo, a clear bug with a test) can go straight
  to a pull request.
- **A safety change** (the sandbox, permissions, the team policy, redaction, the audit log): say
  what threat it addresses, and add a test that fails without the change.

## Build and test

You need Node 22.23.4, 24.22.1 or 26.12.1, or a later release of the same line, pnpm 10 and git. `node scripts/check-node.mjs`
checks your Node. Node 25 and later do not include corepack, so install
pnpm with npm.

```sh
npm install -g pnpm@10
git clone https://github.com/madhu-sv/garuda.git && cd garuda
pnpm install
pnpm check          # typecheck + lint + tests
pnpm build
pnpm link --global  # optional: puts `garuda` on your PATH (run `pnpm setup` once first)
```

From a source build without `pnpm link`, use `node dist/cli/index.js` in place of `garuda`. On
Linux, install bubblewrap (`sudo apt install bubblewrap`), so the sandbox tests run; without it they
skip.

## What a change needs

- **Tests.** A fix comes with a test that fails without the fix (check it: undo the fix and run the
  test). A safety test also needs a control that shows the attack would succeed without the
  defence, and it must fail when you remove the defence.
- **No side effects.** Tests use temporary folders and a temporary home. They never read or write
  your real `~/.garuda`, keys or settings, and they need no network and no API key (use the fake
  model, `src/model/fake.ts`).
- **Checks.** `pnpm check` passes, with zero Biome warnings: a warning counts as a failure. No
  secrets in the change (CI runs gitleaks).
- **Docs with the change.** Update `CHANGELOG.md` (under the unreleased version), the user guide
  (`docs/guide/`) for what a user sees, and the design docs (`docs/lld/`, and `docs/hld.md` or
  `docs/architecture.md` when the design changes).
- **Public claims.** Text about safety must say exactly what the code does. `test/claims.test.ts`
  fails on known overclaims, such as "every command asks first".
- **Plain language.** Docs use short sentences, the active voice and one word for one meaning.

## Pull requests

- One topic per pull request. Fill in the template: what changed, why, how you tested it, and the
  docs that you updated.
- Commit messages: a short summary line, a blank line, then what changed and why.
- CI must be green on Linux and macOS. A change to `main` needs a review by the code owner
  (`.github/CODEOWNERS`).
- By sending a pull request, you agree that your contribution is licensed under the
  [Apache License, Version 2.0](LICENSE), as the rest of the project.

## Layout

| Folder | Holds |
| --- | --- |
| `src/model/` | Provider-neutral types, `ModelClient`, the Anthropic adapter, the fake model |
| `src/loop/` | `runAgent(session, deps)`: the agent loop, limits, loop guard; `replaySession` |
| `src/context/` | Compaction, the system prompt, and the loader of AGENTS.md, CLAUDE.md and GARUDA.md |
| `src/commands/` | Custom slash commands |
| `src/tools/` | `Tool<I, O>`, the registry, and the tools: `read_file`, `glob`, `grep`, `write_file`, `edit_file`, `bash`, `process_manager` |
| `src/permissions/` | Path guard (F15), rules, sensitive paths, settings, and the permission engine (F17–F20) |
| `src/sandbox/` | `Executor` interface, `ExecPolicy`, `HostExecutor`, `SeatbeltExecutor`, `BwrapExecutor`, `DaemonManager`. The only place that starts processes (N8) |
| `src/session/` | Session state, records, `SessionStore` (JSONL files), resume, redaction, read tracking |
| `src/app/` | `Runtime`: settings, executor, permissions and session for one process. The CLI and the evals share it |
| `src/cli/` | Entry point, chat mode, renderer, terminal approver, `garuda eval` |
| `src/evals/` | The eval suites (basic, hard, java, python), the shopkit repo generator, toolchain checks and the runner |
| `src/agents/` | Subagent execution (`child.ts`): the explore subagent (0.3), custom agents (0.5), and Mixture-of-Experts language specialists (0.17) |
| `src/lang/` | Language profiles: build and test commands, prompt notes and sandbox caches for Maven, Gradle and Python projects |
| `src/knowledge/` | The code index: `KnowledgeIndex`, `LanguageExpert`, the TypeScript/JavaScript expert |
| `scripts/` | Build helpers. `package.mjs` makes the standalone binary |
| `test/` | Vitest suites. `loop.test.ts`, `m2.acceptance.test.ts` and `m3.acceptance.test.ts`, `m4.acceptance.test.ts`, `m5.acceptance.test.ts` hold the milestone acceptance tests. `executorContract.ts` is the suite every executor must pass |

## Rules

- The loop gets all dependencies as arguments. It never imports the CLI.
- Only `src/model/anthropic.ts` imports the Anthropic SDK (N1).
- Only `src/sandbox/` may start processes (N8). Biome and a test enforce this.
- Strict TypeScript. No `any` in public interfaces (N7).

## CI and the website

Every pull request runs `.github/workflows/ci.yml`: `pnpm check` and a build on Linux (with
bubblewrap, so the sandbox tests run) and macOS (Seatbelt), and a gitleaks scan of the history. The
jobs have read-only access and get no secrets. Changes to `main` need a pull request and a review by
the code owner (`.github/CODEOWNERS`).

The website lives in `site/` (Astro and Starlight). Its docs pages are generated from `docs/` and the
README at build time (`site/scripts/sync-docs.mjs`), so edit those files, not the generated pages.
`.github/workflows/pages.yml` builds the site for each pull request that changes it, and deploys it
to GitHub Pages from `main`. To work on it: `cd site && pnpm install --ignore-workspace && pnpm dev`.

A tag `v<version>` runs `.github/workflows/release.yml`, which publishes the npm package with npm
trusted publishing (no token in the repository). The steps, the first publish and the Homebrew tap
are in [docs/release.md](docs/release.md).
