# Sandbox and Executor (`src/sandbox/`)

## Purpose

Start every process that Garuda runs: bash commands, hooks, MCP servers (N8). Apply the working
root, the environment allowlist, the timeout, the output cap, and — with an OS sandbox — the file and
network rules. No other folder may import `child_process`.

## Interface (`types.ts`)

```ts
type Isolation = "none" | "os" | "container";

interface ExecPolicy {
  root: string;             // cwd
  sandbox: boolean;         // false: the user approved a run outside the sandbox
  writePaths: string[];     // absolute
  denyWritePaths: string[]; // read-only holes inside writePaths
  denyReadPaths: string[];
  network: boolean;
  envAllowlist: string[];
  timeoutMs: number;
  maxOutputBytes: number;   // per stream
}

interface Executor {
  readonly name: string;    // host | seatbelt | bwrap
  readonly isolation: Isolation;
  run(command, policy, { signal?, env? }): Promise<ExecResult>;       // bash -c, captured
  start(argv, policy, env?): RunningProcess;                           // no shell, piped stdio
  shutdown(): void;         // kill everything now; runs in the "exit" handler
}
```

`ExecResult`: exit code, signal, stdout and stderr (`text`, `truncated`, `totalBytes`), `timedOut`,
`aborted`, `durationMs`.

## ProcessExecutor (`process.ts`)

The shared base class. Subclasses implement only `launch(argv, policy) → { file, args }`.

- `spawn` with `detached: true`: the command leads its own process group. A timeout, Ctrl-C (abort
  signal) or `shutdown()` signals the whole group: SIGTERM, then SIGKILL after 2 s. After the main
  process exits, the group gets SIGKILL too, so background children do not stay.
- Environment: only the allowlisted variables of Garuda's environment, plus `options.env`.
- Output: `OutputCapture` keeps the start and the end of each stream within `maxOutputBytes` and cuts
  the middle; the start shows what ran, the end shows how it finished.
- `start()` registers the process group in the same set, so `shutdown()` also stops MCP servers.

## Executors

| Executor | Platform | Launch |
| --- | --- | --- |
| `HostExecutor` | any | The program itself. Isolation `none`: every command asks for approval. |
| `SeatbeltExecutor` | macOS | `/usr/bin/sandbox-exec -p <profile> <argv>` |
| `BwrapExecutor` | Linux | `bwrap <mounts> --die-with-parent --chdir <root> -- <argv>` |

With `policy.sandbox === false`, the OS executors launch the program with no isolation.

### Seatbelt profile (`seatbeltProfile`)

```text
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath <writePath>)… /dev/null /dev/zero /dev/dtracehelper /dev/tty* /dev/fd/*)
(deny file-write* (subpath <denyWritePath>)…)     ; after the allow: the last matching rule wins
(deny file-read* (subpath <denyReadPath>)…)
(deny network-outbound (remote ip "*:*"))          ; when network is false
(deny network-inbound (local ip "*:*"))
(deny network-bind (local ip "*:*"))
(allow network-* … "localhost:*")                  ; test servers keep working
```

Paths are Scheme strings with `\` and `"` escaped.

### bubblewrap arguments (`bwrapArgv`)

```text
--ro-bind / /  --dev /dev
--bind <p> <p>               for each existing write path
--ro-bind <p> <p>            for each existing protected path
--tmpfs <dir> --remount-ro <dir>   or   --ro-bind /dev/null <file>   for each denied read path
--unshare-net                when network is false (only a loopback interface)
--die-with-parent --chdir <root> -- <argv>
```

No `--unshare-pid` and no `--new-session`: the command stays in Garuda's process group, so the group
kill works and pids match the host. Limit: bubblewrap needs each mount point to exist, so a protected
path that does not exist yet (for example `.git/hooks` with no `.git`) is not protected.

## Selection (`index.ts`)

`createExecutor(name)` with `name` from settings:

| Name | Result |
| --- | --- |
| `auto` (default) | The OS sandbox when it works, otherwise `HostExecutor` with a notice that says why and how to fix it. |
| `os` | The OS sandbox, or an error. |
| `host` | `HostExecutor`. |

`findOsSandbox()` (cached per process): on macOS, `/usr/bin/sandbox-exec` must exist; on Linux, `bwrap`
must be on `PATH` and a probe (`bwrap --ro-bind / / --dev /dev --unshare-net … true`) must succeed,
because user namespaces can be off.

## Tests

`test/executorContract.ts` is one suite that every executor must pass: output, exit code, working folder,
environment allowlist, output cap, timeout, `shutdown()`, and process-tree kill on abort.
`test/hostExecutor.test.ts` runs it for the host; `test/sandbox.test.ts` runs it for the machine's OS
sandbox, plus real checks: writes outside the root fail, protected paths stay read-only, denied reads
fail, no network, and `sandbox: false` isolates nothing. The Seatbelt tests run only on macOS.
