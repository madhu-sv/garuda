# Sandbox and Executor (`src/sandbox/`)

## Purpose

Start every process that Garuda runs: bash commands, hooks, MCP servers (N8). Apply the working
root, the environment allowlist, the timeout, the output cap, and — with an OS sandbox — the file and
network rules. No other folder may import `child_process`.

One exception to the Executor (0.6): `terminal.ts` `runInTerminal(argv)` runs the user's own editor
(Ctrl-G, `/editor`) with the real terminal (`spawnSync`, `stdio: "inherit"`), because an editor needs the
terminal and the Executor captures output. Only the chat calls it, on a key the user pressed; no tool can.

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
  readonly daemons?: DaemonManager;                                   // background process manager (0.14)
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

## Network allowlist (0.13)

`ExecPolicy.proxy` (`{ port, socketPath, bridge? }`) is set by the permission engine when the runtime
runs Garuda's proxy (`src/net/proxy.ts`), and only for sandboxed commands (not hooks, not language
servers). With `sandbox` and no `network`:

- `proxyEnv(policy)` (in `ProcessExecutor`, so every executor) adds `HTTP_PROXY`, `HTTPS_PROXY` (and the
  lower-case forms), `NO_PROXY=localhost,127.0.0.1,::1`, `NODE_USE_ENV_PROXY=1`, and the Java proxy
  properties in `MAVEN_OPTS` and `GRADLE_OPTS`, all to `http://127.0.0.1:<port>`.
- Seatbelt already allows localhost, so the command reaches the proxy's TCP port directly.
- bubblewrap has its own network namespace (`--unshare-net`): `withBridge` runs `bash -c` with a small
  script that starts `node -e BRIDGE_JS <socket> <port>` in the background (no output), waits until
  127.0.0.1:<port> answers (up to 2 s), then `exec`s the command. The bridge forwards each connection to
  the proxy's Unix socket (visible through the read-only root). The executor kills the process group
  after the command, so the bridge ends with it.

The proxy (`NetworkProxy`): an HTTP server on 127.0.0.1:0 and on a Unix socket in a private temp folder.
`CONNECT host:port` (https) and absolute-URL requests (http). For each: IP literals are refused (the list
names hosts); `decide(host, port)` (the runtime: ports 80 and 443 only; the list; else the permission
engine with tool `network` and a URL target, which applies rules, session answers, the job's
deny-and-continue or a question); then the host is resolved and every address must be public
(`checkAddress`); the connection goes to the checked address (no rebinding). A refusal is `403` with the
reason in the body; `takeBlocked()` gives the blocked hosts to the bash tool, which adds a note for the
model. The proxy does not decrypt TLS. When the proxy starts, the runtime adds a note to the first prompt
(`networkNote`) that names the hosts and asks the model to run those commands, and commands for other
hosts (the proxy asks the user), in the sandbox (live test:
without it the model asked for `outside_sandbox` at once, because the tool text says "no network").

Live test (0.13, macOS, Seatbelt, `"allow": ["npm"]`): the consent showed the npm hosts and "remember"
pinned the list (a new chat only showed the notice); `npm view lodash version` ran in the sandbox through
the proxy with no question; `curl -sI https://example.com` asked "Let a command reach example.com?", and
after a denial curl ended with exit code 56 (the proxy's 403) and the model named the two ways to allow
the host. The Linux bridge is tested in the cloud (bubblewrap, curl through the proxy).

## Selection (`index.ts`)

`createExecutor(name)` with `name` from settings:

| Name | Result |
| --- | --- |
| `auto` (default) | The OS sandbox when it works, otherwise `HostExecutor` with a notice that says why and how to fix it. |
| `os` | The OS sandbox, or an error. |
| `host` | `HostExecutor`. |

`findOsSandbox()` (cached per process):
- On macOS, `/usr/bin/sandbox-exec` must exist, and an active probe (`probeSeatbelt()`) running
  `/usr/bin/sandbox-exec -p '(version 1) (allow default)' /bin/sh -c 'true'` must succeed. In nested
  sandboxes or environments where Seatbelt invocation is blocked by the kernel (error 71 `EX_OSPERM`),
  the probe detects this and falls back to `HostExecutor` with an informative notice.
- On Linux, `bwrap` must be on `PATH` and a probe (`bwrap --ro-bind / / --dev /dev --unshare-net … true`)
  must succeed, because user namespaces can be off.

## Background daemons (`daemon.ts`, 0.14)

Long-running dev servers, watchers, and support processes can be launched via `bash` with `is_daemon: true`.

- `DaemonManager` tracks background processes started during the session.
- Subprocesses lead their own detached process groups (`detached: true`).
- Standard output and standard error are captured in a rolling circular buffer (`DaemonLogBuffer`, up to 1 MB per daemon).
- Child processes are tracked: PID, command, arguments, cwd, start time, exit code/signal, and status (`running`, `exited`, `killed`).
- Operations via `DaemonManager`:
  - `start(command, argv, policy, env?)`: Launches the daemon process and returns its descriptor.
  - `list()`: Returns status and summaries of active and recent daemons.
  - `logs(id, maxBytes?)`: Retrieves tail logs from the daemon's ring buffer.
  - `kill(id, signal?)`: Sends SIGTERM, followed by SIGKILL after 2 s to the entire process group.
- Clean shutdown: `Executor.shutdown()` calls `DaemonManager.shutdown()`, ensuring no dangling child processes or orphaned dev servers survive after Garuda exits.

## Tests

`test/executorContract.ts` is one suite that every executor must pass: output, exit code, working folder,
environment allowlist, output cap, timeout, `shutdown()`, and process-tree kill on abort.
`test/hostExecutor.test.ts` runs it for the host; `test/sandbox.test.ts` runs it for the machine's OS
sandbox, plus real checks: writes outside the root fail, protected paths stay read-only, denied reads
fail, no network, and `sandbox: false` isolates nothing. The Seatbelt tests run only on macOS.
`test/daemon.test.ts` (0.14) tests daemon launch, log capture, output streaming, status reporting, kill,
and executor shutdown cleanup.
`test/networkProxy.test.ts` (0.13) tests the allowlist, the proxy (tunnel, 403 with the reason, IP
literals, private addresses, plain http) and curl through the machine's OS sandbox with and without the
proxy; `test/network.test.ts` the runtime (consent, pinning, questions, ports), evals and jobs.
