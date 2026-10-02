# Tools (`src/tools/`)

## Tool interface (`types.ts`)

```ts
interface Tool<I, O> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;          // validation (F16) and, by default, the JSON Schema
  jsonSchema?: Record<string, unknown>; // schema given as is (MCP tools)
  readOnly: boolean;                  // read-only: no approval (F17), may run in parallel (F8)
  runsCommands?: boolean;             // the session log records the executor (N8)
  describe?(input, ctx): Promise<CallInfo>; // target + preview, before approval (F18)
  run(input, ctx): Promise<O>;
  toText?(output: O): string;
  isError?(output: O): boolean;       // an error result that is not an exception (MCP)
  report?(output: O): SubagentReport | undefined; // a subagent's usage, for the session totals
}

interface ToolContext {
  root; signal; permissions: PermissionGate; files: FileTracker;
  executor?: Executor; knowledge?: KnowledgeIndex; hooks?: ToolHooks;
  callId?: string; progress?: (text: string) => void;   // set by the loop for each call
  diagnostics?: DiagnosticsSource;                        // LSP errors after a write (0.4)
}
```

`afterWrite(result, context, file)` (0.10) runs after edit_file and write_file: the formatter, if on
(`context.format`, see [format.md](format.md)), then `withDiagnostics(result, context, file)`, which adds
the diagnostics text after a tool's own result. Neither fails the call: the file is already written.

`ToolRunner` is what the loop needs (`specs`, `isReadOnly`, `runsCommands`, `execute`). `ToolRegistry`
implements it; replay uses a recorded one. `isReadOnly` decides the loop's parallel batches: a read-only tool with
`runsAlone` (0.5: the agent tool when an agent may write) is not batched, while the permission engine still
treats it as read-only.

## Registry (`registry.ts`)

- `specs()`: tools sorted by name; `jsonSchema` or `z.toJSONSchema(inputSchema, { io: "input" })`.
  A stable order keeps the prompt cache valid (N2).
- `execute(call, ctx)` — never throws, except when the turn is aborted:
  1. Unknown tool → error result.
  2. Zod validation → error result with a readable message.
  3. `describe()` (or an `input` target for tools without it; nothing for read-only tools without it).
  4. `hooks.before()` → "Blocked by a hook: …".
  5. `permissions.check()` → "Permission denied: …", with `denied: true` on the outcome (0.5: the JSON
     output lists these calls in `permission_denials`).
  6. `run()`, `toText()`, `isError()`.
  7. `hooks.after()` may append feedback.
  8. `report()`, when the tool has it, adds the subagent report to the outcome.
  Any exception becomes `Error: <tool> failed: <message>`.

## Built-in tools

| Tool | Read-only | Target | Behaviour and limits |
| --- | --- | --- | --- |
| `read_file` (F9) | yes | path | Numbered lines (`cat -n`), `offset` and `limit` (max 2000 lines), lines cut at 2000 chars, output ≤ 50 000 chars, files ≤ 10 MB, no binaries, no folders. Records the file for `edit_file`. Read deduplication: the same offset/limit on an unchanged file returns a short note instead of the lines. |
| `glob` (F12) | yes | – | globby, respects `.gitignore`, skips `.git/`, does not follow symlinks, newest first, at most 200 paths. Absolute patterns and `..` are refused. |
| `grep` (F13) | yes | – | JavaScript regex, written in TypeScript (no ripgrep binary). Modes `files`, `content`, `count`; `glob`, `ignoreCase`, `context` (0–5). Skips binary files, files > 1 MB and sensitive files. Default 100 results, max 500. |
| `write_file` (F10) | no | path | Create only (fails if the file exists), folders created, atomic (temp file + hard link). Approval shows the diff. With LSP on, the result adds the errors of the new file (see [lsp.md](lsp.md)). |
| `edit_file` (F11) | no | path | Replace one exact `old_string`. Fails on 0 or several matches, and when the file is unread or changed since the last read. The edit is planned before approval (real diff) and planned again after it. Atomic write that keeps the file mode and follows symlinks. With LSP on, the result adds the errors of the changed file. Partial approval (U0): `describe` sets `hunks: true` when the preview is complete; with `context.approvedHunks` it writes only those hunks (`applyHunks`), refuses when the change differs from the reviewed preview, and names the rejected hunks in the result. |
| `bash` (F14) | no | command | Runs through the Executor; timeout default 120 s, max 600 s; stdout and stderr capped at 30 000 bytes each (middle cut). Strips a leading `cd <root> &&`. Hints: read-only commands (use file tools), pipes into head/tail, sandbox blocks. `outside_sandbox: true` runs with no isolation and always asks. `is_daemon: true` (0.14) starts a background daemon process and returns immediately with its process ID. |
| `process_manager` (0.14) | yes | action, id? | Manage background daemon processes: `list` (active and recent daemons), `logs` (circular tail buffer), `status` (PID, uptime, exit code), and `kill` (SIGTERM/SIGKILL process tree). Read-only: inspects and terminates background processes without prompting. |
| `todo_write` | yes | – | The model's plan for a task with several steps: the whole list each call (≤ 30 steps of ≤ 300 characters; status `pending`, `in_progress`, `completed`; at most one in progress). The result shows the list back with `[x]`, `[>]`, `[ ]`; the chat draws a checklist. No state outside the conversation. Only with `todo.enabled: true` (off by default: in the A/B eval the model never called it, 0.4). |
| `remember` | no | input | Appends one fact to `.garuda/memory.md` (max 8000 chars). The user approves each fact. Loads in the next session only (N2). |
| `find_symbol` | yes | – | Code index: definitions (exact or fuzzy). Only when `codeIndex` is `lookup` or `all`. |
| `find_references` | yes | – | Code index: every use, following imports. `lookup` or `all`. |
| `find_callers` (0.15) | yes | – | Code index: invocation sites and enclosing caller scope (class, method, function). `lookup` or `all`. |
| `impact_analysis` (0.15) | yes | target | Code index: blast radius, direct dependents, caller graph, risk level, and test suite discovery. `lookup` or `all`. |
| `ast_query` (0.15) | yes | – | Code index: structural AST query filtering by kind, visibility, container, and wildcards. `lookup` or `all`. |
| `repo_map` | yes | – | Code index: exports and imports per file; a folder summary above 30 files. `all` only. |
| `web_fetch` | no | URL | See [web.md](web.md). Present unless `web.enabled` is false. |
| `explore` | yes | – | A read-only subagent answers one question about the code. See [agents.md](agents.md). Only with `subagents.enabled: true` (off by default). |
| `web_search` | no | input | The user's search backend (0.5). Each search asks, unless allowed for the session or by the rule `web_search`. See [web.md](web.md). Only when a backend is set. Claude's search (0.6) is not a Garuda tool: the model client sends it as a server tool, and it replaces this tool in the request. |
| `skill` | yes | – | Loads a skill's instructions or one of its files (0.5). See [skills.md](skills.md). Only when skills exist. |
| `agent` | yes (`runsAlone` when an agent may write) | – | Hands a task to a custom agent (0.5). See [agents.md](agents.md). Only when agent files exist. |
| `mcp__<server>__<tool>` | no | input | See [mcp.md](mcp.md). |

`readOnlyTools(codeIndex)` gives the tool set of a subagent.

Helpers: `limits.ts` (`LIMITS`, `cutLine`, `joinWithinLimit`, `looksBinary`), `files.ts` (`listFiles`,
`assertSafePattern`), `diff.ts` (unified diff for previews), `atomicWrite.ts`.

## Paths

Every file tool resolves paths with `resolveInRoot` (see [permissions.md](permissions.md)): the path
must be inside the root, both as written and as a real path, so a symbolic link cannot lead out. Paths
in results and targets are shown relative to the root.

## Tests

`test/tools.test.ts`, `test/writeTools.test.ts`, `test/pathGuard.test.ts`, `test/codeIndex.test.ts`,
`test/webFetch.test.ts`, `test/m2`/`m3.acceptance.test.ts`.
