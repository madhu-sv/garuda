# LSP diagnostics (`src/lsp/`)

## Purpose

After `edit_file` or `write_file` changes a TS/JS, Python or Java file, a real language server checks the file,
and the tool result lists its errors. The model sees a type error at once, not after a test run. Added in
0.4. Off by default: the A/B evals (hard suite for TS, java suite for jdtls) showed no gain and no extra
cost, because the model made no type errors there (see [evals.md](evals.md#method)).

```
Edited src/cart.ts.

1 error in src/cart.ts after this change (tsc):
  14:7 Type 'string' is not assignable to type 'number'. [2322]
```

| File | Role |
| --- | --- |
| `servers.ts` | Languages, file extensions, server candidates, discovery (reads the file system only). |
| `jdtls.ts` | Java: the jdtls install folder, a Java 21+ runtime, the `java` command, readiness, the managed install from download.eclipse.org. |
| `client.ts` | `LspClient`: JSON-RPC (vscode-jsonrpc) over the pipes of a started process; the handshake, file sync, pull and push diagnostics. |
| `manager.ts` | `LspManager`: one server per language, started on first use; failures and notices; the `/lsp` text. |
| `format.ts` | The text after the edit result: errors only, at most 20 lines. |
| `install.ts` | The managed install of pinned versions into `~/.garuda/lsp/<language>` (npm, or the jdtls download). |
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
| java | `.java` | `jdtls` (Eclipse JDT Language Server), started as a `java` command (see below) |

Discovery (`findServer`, `discoverServer`) looks in two places, in this order:

1. The managed install: `~/.garuda/lsp/<language>/node_modules/.bin` (Java: `~/.garuda/lsp/java/jdtls/bin/jdtls`).
2. `PATH`. Only absolute entries outside the project root: a cloned repository must not be able to plant a
   "language server" (for example in `node_modules/.bin`) that Garuda then starts.

For `tsc`, `isTypeScript7` reads the `package.json` next to the real program (or
`node_modules/typescript/package.json` beside a pnpm shim). Discovery starts no process (N8). A program
that is found but cannot start (for example jdtls with no Java 21) is skipped, and `/lsp` shows why.

## Java (jdtls)

jdtls is a Java program, so Garuda builds the command itself (`jdtlsLaunch`):

- **Install folder:** the folder with `plugins/org.eclipse.equinox.launcher_*.jar` and `config_*`. For a
  `jdtls` script, Garuda tries its real path's parent, a `libexec` beside it (Homebrew), and absolute paths
  in the script.
- **Java:** jdtls needs Java 21 or later. Garuda takes the first JDK of version 21 or later from:
  `JAVA_HOME`, a `JAVA_HOME` in the launcher script (Homebrew), `java` on PATH (its real path), then
  `/Library/Java/JavaVirtualMachines`, `/opt/homebrew/opt`, `/usr/local/opt` and `/usr/lib/jvm`. It reads
  the version from the JDK's `release` file; it never runs `java -version`.
- **Configuration:** the config folder for the OS and CPU (`config_mac_arm`, `config_mac`, `config_linux`
  …) is the shared, read-only OSGi configuration; jdtls writes its own under
  `~/.cache/garuda/jdtls/config-<hash of the install>`. The workspace data is in
  `~/.cache/garuda/jdtls/workspace/<hash of the root>`. `~/.cache` is writable in the sandbox; the
  install folder and the project are not.
- **Settings** (initializationOptions): no `.project` or `.classpath` files in the project
  (`java.import.generatesMetadataFilesAtProjectRoot: false`), Maven and Gradle offline, autobuild on.
- **Ready:** jdtls answers requests before it has imported the project, and its errors are wrong until
  then ("cannot be resolved"). The first check waits for `language/status` `Started` (or `Error`). If that
  does not come in time, later checks give no text at once, until it comes.
- **Warm start:** with LSP on and a Maven or Gradle profile, `runTurn` starts jdtls at the start of the
  turn (`LspManager.warm`), so the import runs while the model reads files. The first check waits up to
  120 s.
- **Offline:** the sandbox has no network. A Maven project imports from `~/.m2` (run a build once with
  network, as for the Java eval suite). A Gradle project needs its Gradle distribution in `~/.gradle`.
- **Memory:** `-Xmx1G`.

## Managed install

`garuda lsp install typescript|python|java` (or `/lsp install …` in the chat). TS/JS and Python run:

```
npm install --prefix ~/.garuda/lsp/<language> --ignore-scripts --no-audit --no-fund --loglevel=error <package>
```

| Language | Package |
| --- | --- |
| typescript | `typescript@7.0.2` |
| python | `pyright@1.1.414` |
| java | jdtls `1.61.0` (download, not npm) |

For Java, the install downloads the pinned milestone from
`https://download.eclipse.org/jdtls/milestones/1.61.0/`: the file name comes from `latest.txt` (or the
folder listing), its `.sha256` file must exist and match (0.14.1, review: a missing file let the install go on unchecked; the checksum comes from the same server, so a pinned hash is still open), and the archive is unpacked into
`~/.garuda/lsp/java/jdtls`. It needs `curl` and `tar`. `brew install jdtls` works too (PATH).

- The versions are pinned; a new Garuda version moves them.
- The download needs the network, so it runs outside the sandbox, through the Executor, with the default
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

The edit is already written (and formatted, 0.10) when the check runs. `withDiagnostics` adds the text after the tool's own
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
silent, crash, slow-init and jdtls):

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

`test/lsp.java.test.ts`, with fake JDKs (a `release` file, and a `java` that runs the fake server) and
fake jdtls install folders:

- `.java` files; the `release` version; the Java search order; a Homebrew-style launcher; the config
  folder per OS and CPU; the command (shared configuration, cache folders, one workspace per root); "needs
  Java 21" in `/lsp`; the install command; the managed install.
- The client: the settings go with initialize; the first check waits for `Started`; after one timeout,
  no more waits.
- In the OS sandbox: a warm start, then the errors of an edited `.java` file.
- The real jdtls, only with `GARUDA_TEST_JDTLS=1` (20–60 s): a type error and its fix.
