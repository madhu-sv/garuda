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
}

interface ToolContext {
  root; signal; permissions: PermissionGate; files: FileTracker;
  executor?: Executor; knowledge?: KnowledgeIndex; hooks?: ToolHooks;
}
```

`ToolRunner` is what the loop needs (`specs`, `isReadOnly`, `runsCommands`, `execute`). `ToolRegistry`
implements it; replay uses a recorded one.

## Registry (`registry.ts`)

- `specs()`: tools sorted by name; `jsonSchema` or `z.toJSONSchema(inputSchema, { io: "input" })`.
  A stable order keeps the prompt cache valid (N2).
- `execute(call, ctx)` — never throws, except when the turn is aborted:
  1. Unknown tool → error result.
  2. Zod validation → error result with a readable message.
  3. `describe()` (or an `input` target for tools without it; nothing for read-only tools without it).
  4. `hooks.before()` → "Blocked by a hook: …".
  5. `permissions.check()` → "Permission denied: …".
  6. `run()`, `toText()`, `isError()`.
  7. `hooks.after()` may append feedback.
  Any exception becomes `Error: <tool> failed: <message>`.

## Built-in tools

| Tool | Read-only | Target | Behaviour and limits |
| --- | --- | --- | --- |
| `read_file` (F9) | yes | path | Numbered lines (`cat -n`), `offset` and `limit` (max 2000 lines), lines cut at 2000 chars, output ≤ 50 000 chars, files ≤ 10 MB, no binaries, no folders. Records the file for `edit_file`. Read deduplication: the same offset/limit on an unchanged file returns a short note instead of the lines. |
| `glob` (F12) | yes | – | globby, respects `.gitignore`, skips `.git/`, does not follow symlinks, newest first, at most 200 paths. Absolute patterns and `..` are refused. |
| `grep` (F13) | yes | – | JavaScript regex, written in TypeScript (no ripgrep binary). Modes `files`, `content`, `count`; `glob`, `ignoreCase`, `context` (0–5). Skips binary files, files > 1 MB and sensitive files. Default 100 results, max 500. |
| `write_file` (F10) | no | path | Create only (fails if the file exists), folders created, atomic (temp file + hard link). Approval shows the diff. |
| `edit_file` (F11) | no | path | Replace one exact `old_string`. Fails on 0 or several matches, and when the file is unread or changed since the last read. The edit is planned before approval (real diff) and planned again after it. Atomic write that keeps the file mode and follows symlinks. |
| `bash` (F14) | no | command | Runs through the Executor; timeout default 120 s, max 600 s; stdout and stderr capped at 30 000 bytes each (middle cut). Strips a leading `cd <root> &&`. Hints: read-only commands (use file tools), pipes into head/tail, sandbox blocks. `outside_sandbox: true` runs with no isolation and always asks. |
| `remember` | no | input | Appends one fact to `.garuda/memory.md` (max 8000 chars). The user approves each fact. Loads in the next session only (N2). |
| `find_symbol` | yes | – | Code index: definitions (exact or fuzzy). Only when `codeIndex` is `lookup` or `all`. |
| `find_references` | yes | – | Code index: every use, following imports. `lookup` or `all`. |
| `repo_map` | yes | – | Code index: exports and imports per file; a folder summary above 30 files. `all` only. |
| `web_fetch` | no | URL | See [web.md](web.md). Present unless `web.enabled` is false. |
| `mcp__<server>__<tool>` | no | input | See [mcp.md](mcp.md). |

Helpers: `limits.ts` (`LIMITS`, `cutLine`, `joinWithinLimit`, `looksBinary`), `files.ts` (`listFiles`,
`assertSafePattern`), `diff.ts` (unified diff for previews), `atomicWrite.ts`.

## Paths

Every file tool resolves paths with `resolveInRoot` (see [permissions.md](permissions.md)): the path
must be inside the root, both as written and as a real path, so a symbolic link cannot lead out. Paths
in results and targets are shown relative to the root.

## Tests

`test/tools.test.ts`, `test/writeTools.test.ts`, `test/pathGuard.test.ts`, `test/codeIndex.test.ts`,
`test/webFetch.test.ts`, `test/m2`/`m3.acceptance.test.ts`.
