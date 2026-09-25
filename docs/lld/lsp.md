# LSP diagnostics (`src/lsp/`)

## Purpose

After `edit_file` or `write_file` changes a TS/JS or Python file, a real language server checks the file,
and the tool result lists its errors. The model sees a type error at once, not after a test run. Added in
0.4. Off by default until an A/B eval shows a gain.

```
Edited src/cart.ts.

1 error in src/cart.ts after this change (tsc):
  14:7 Type 'string' is not assignable to type 'number'. [2322]
```

| File | Role |
| --- | --- |
| `servers.ts` | Languages, file extensions, server candidates, discovery (reads the file system only). |
| `client.ts` | `LspClient`: JSON-RPC (vscode-jsonrpc) over the pipes of a started process; the handshake, file sync, pull and push diagnostics. |
| `manager.ts` | `LspManager`: one server per language, started on first use; failures and notices; the `/lsp` text. |
| `format.ts` | The text after the edit result: errors only, at most 20 lines. |
| `install.ts` | The managed install: `npm install` of pinned versions into `~/.garuda/lsp/<language>`. |
| `config.ts` | `~/.garuda/lsp.json` (`autoInstall`). |

## Turn it on

| Where | Effect |
| --- | --- |
| `"lsp": { "enabled": true }` in `.garuda/settings.json` | On for the project. |
| `garuda --lsp` | On for this run. |
| `garuda eval --lsp on` | On for an eval run (A/B). |

When it is on, the system prompt gets two lines: the result lists the errors of the changed file; fix the
errors that your change caused. The banner shows `LSP`.

## Servers

| Language | Extensions | Candidates, in order |
| --- | --- | --- |
| typescript | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | `tsc --lsp --stdio` (TypeScript 7 or later), `tsgo --lsp --stdio`, `typescript-language-server --stdio` |
| python | `.py .pyi` | `basedpyright-langserver --stdio`, `pyright-langserver --stdio` |

Discovery (`discoverServer`) looks in two places, in this order:

1. The managed install: `~/.garuda/lsp/<language>/node_modules/.bin`.
2. `PATH`. Only absolute entries outside the project root: a cloned repository must not be able to plant a
   "language server" (for example in `node_modules/.bin`) that Garuda then starts.

For `tsc`, `isTypeScript7` reads the `package.json` next to the real program (or
`node_modules/typescript/package.json` beside a pnpm shim). Discovery starts no process (N8).

## Managed install

`garuda lsp install typescript|python` (or `/lsp install …` in the chat) runs:

```
npm install --prefix ~/.garuda/lsp/<language> --ignore-scripts --no-audit --no-fund --loglevel=error <package>
```

| Language | Package |
| --- | --- |
| typescript | `typescript@7.0.2` |
| python | `pyright@1.1.414` |

- The versions are pinned; a new Garuda version moves them.
- npm needs the network, so it runs outside the sandbox, through the Executor, with the default
  environment plus proxy and registry variables. Timeout 300 s.
- Install scripts are off. The packages need none (TypeScript 7 gets its native binary as an optional
  dependency).

Default: Garuda installs nothing by itself. With `{ "autoInstall": true }` in `~/.garuda/lsp.json`, the
first edit of a language with no server asks: "Install it?" (yes, or go on without diagnostics). The file
is only in the home folder: a project must not be able to make Garuda download programs.

`garuda lsp` and `/lsp` show the state: on or off, and per language the server, its source (managed or
PATH), its path, and `found`, `running` or `failed: …`.

## Running a server

- Through `Executor.start` (N8), with `PermissionEngine.serverPolicy()`: in the OS sandbox, the project
  read-only (the same rule as plan mode), temp folders and caches writable, no network, no time limit.
- Only with an OS sandbox. A server reads project configuration and can run project programs (pyright
  runs the Python of a project virtual environment), so on a machine with no sandbox it stays off, with one
  notice.
- Started on the first edit of a file of its language, and kept for the session. `Runtime.close()` sends
  `shutdown` and `exit`, then stops the process. The executor's `shutdown()` kills it in any case.
- The module and vscode-jsonrpc load only on the first edit (N3).

## Protocol (`client.ts`)

1. `initialize` with the root as the workspace folder, and the capabilities: publishDiagnostics with
   version support, pull diagnostics, workspace configuration. Then `initialized`.
2. Server requests: `workspace/configuration` gets `null` for each item; other requests get `null`.
   Log and progress notifications are ignored.
3. Each check: `didOpen` the first time, then `didChange` with the full text and a new version. Old
   published diagnostics for the file are dropped before the send.
4. Diagnostics:
   - The server offers `diagnosticProvider`: pull with `textDocument/diagnostic`.
   - Otherwise: wait for `publishDiagnostics` of this version (or a later one; any, if the server sends
     no version).
5. Timeouts: 30 s for `initialize`, 30 s for the first diagnostics (the server loads the project),
   5 s after that. A slow start is not a slow check: `initialize` has its own timeout.

The client checks only the changed file. It does not follow files that bash or the user change; the next
edit of a file sends its full text again.

## Output (`format.ts`)

- Errors only: severity 1, or no severity (the LSP lets the client decide). Warnings and hints are left
  out.
- Sorted by line and column; the first line of each message, at most 300 characters; the code in brackets.
- At most 20 lines, then `… and N more.`
- No errors: `No errors in <path> (<server>).`
- Server text is outside text: `cleanText` removes escape codes and hidden characters.

## Failures never block an edit

The edit is already written when the check runs. `withDiagnostics` adds the text after the tool's own
result, and adds nothing when:

| Case | Behaviour |
| --- | --- |
| Not a known language | No text. |
| No server | No text. The state is `missing`; `/lsp` says how to install. |
| No OS sandbox | No text; one notice; the state is `failed`. |
| The server does not start, or stops | No text; one notice ("… diagnostics are off for this session"); no restart. |
| Too slow | No text; one notice per server; the server stays. |
| Ctrl-C | No text; the turn stops as usual. |

## Tests

`test/lsp.test.ts`, with a fake server (`test/fixtures/lspServer.mjs`, modes pull, push, push-old,
silent and crash):

- Extensions; discovery order; the project, relative PATH entries and non-programs are skipped; the
  TypeScript 7 check (with a pnpm shim).
- The text: errors only, sorting, the cap, cleaning.
- `lsp.json`; the install command and policy (fake executor).
- The client: pull, push and a stale push; a slow `initialize` with short check timeouts; a timeout;
  Ctrl-C.
- `edit_file` and `write_file` with a diagnostics source; a failing source changes nothing.
- Off by default; the setting, the option, the prompt lines and the banner.
- The manager with no sandbox (one notice), with no server, and in the OS sandbox: a fake server, a crash,
  a slow server, autoInstall, a whole turn through `Runtime`, and the real `tsc --lsp` of the repository.
- `/lsp`, and an approval with two choices and its own question.
