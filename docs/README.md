# Garuda documentation

Garuda is a terminal coding agent in TypeScript on Node. This folder describes how it is built.
The website shows these documents at https://madhu-sv.github.io/garuda/docs/design/ (generated from
this folder at each deploy).

| Document | What it answers |
| --- | --- |
| [Architecture](architecture.md) | What the parts are, how they depend on each other, where the trust boundaries are, and why. |
| [High-level design](hld.md) | How a task flows through the system: start, turns, tool calls, approvals, sandbox, sessions, extensions. |
| Low-level design | One document per component: its types, algorithms, limits and tests. |
| [Release](release.md) | How a version goes to npm (trusted publishing) and to the Homebrew tap. |

Low-level design documents:

| Component | Source | Document |
| --- | --- | --- |
| CLI and chat | `src/cli/` | [cli.md](lld/cli.md) |
| Runtime and agent loop | `src/app/`, `src/loop/` | [runtime-and-loop.md](lld/runtime-and-loop.md) |
| Models and providers | `src/model/` | [model.md](lld/model.md) |
| Tools | `src/tools/` | [tools.md](lld/tools.md) |
| Permissions | `src/permissions/` | [permissions.md](lld/permissions.md) |
| Sandbox (Executor) | `src/sandbox/` | [sandbox.md](lld/sandbox.md) |
| Sessions | `src/session/` | [session.md](lld/session.md) |
| Context (prompt, memory, compaction) | `src/context/` | [context.md](lld/context.md) |
| Code index | `src/knowledge/` | [knowledge.md](lld/knowledge.md) |
| MCP client | `src/mcp/` | [mcp.md](lld/mcp.md) |
| Web fetch and web search | `src/web/`, `src/net/`, `src/tools/webFetch.ts`, `src/tools/webSearch.ts` | [web.md](lld/web.md) |
| Hooks | `src/hooks/` | [hooks.md](lld/hooks.md) |
| Language profiles | `src/lang/` | [languages.md](lld/languages.md) |
| Subagents (explore, custom agents, MoE language specialists) | `src/agents/` | [agents.md](lld/agents.md) |
| Custom slash commands | `src/commands/` | [commands.md](lld/commands.md) |
| LSP diagnostics | `src/lsp/` | [lsp.md](lld/lsp.md) |
| Undo | `src/undo/`, `src/session/undo.ts` | [undo.md](lld/undo.md) |
| Init and migration | `src/init/` | [init.md](lld/init.md) |
| Skills | `src/skills/` | [skills.md](lld/skills.md) |
| Evals | `src/evals/` | [evals.md](lld/evals.md) |
| Scheduled jobs (0.7), proof of work and the night shift (0.11) | `src/jobs/`, `src/cli/jobCommand.ts`, `src/cli/nightCommand.ts` | [jobs.md](lld/jobs.md) |
| Formatters (0.10) | `src/format/`, `afterWrite` in `src/tools/types.ts` | [format.md](lld/format.md) |
| Editors over ACP (0.15) | `src/acp/`, `src/cli/acpCommand.ts` | [acp.md](lld/acp.md) |
| Bounded changes (0.17, planned): staged commands, job write scopes, strict profile, audit checkpoint, shared budget | `src/sandbox/`, `src/permissions/`, `src/jobs/`, `src/audit/`, `src/agents/`, `src/knowledge/` | [bounded-changes.md](lld/bounded-changes.md) |
| Setup and stored keys (0.16) | `src/model/credentials.ts`, `src/model/providers.ts`, `src/cli/setupCommand.ts` | [setup.md](lld/setup.md) |

The requirements doc defines the IDs used here: F1–F26 (functional) and N1–N8 (non-functional).
The code, the tests and the commits use the same IDs. The documents describe version 0.16.1 (`garuda setup` and the editor sign-in; editors over ACP since 0.15.0; on top of 0.14.1: the 0.14–0.17 branches after the merge gate and Garuda's own review of nine areas).
