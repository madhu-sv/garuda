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
  writeScope?: { root: string; paths: string[] }; // a job's write scope (0.17), see below
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

`writeScope` (0.17, review T6): a scheduled job's write scope. The root is read-only, except
`paths`. The executors apply it after `writePaths` (so a writable parent such as `/tmp` does not
open the root) and before `denyWritePaths` and `denyReadPaths` (so protected and denied paths in a
scope folder stay protected). Seatbelt: `(deny file-write* root)`, then `(allow file-write* paths)`;
the last matching rule wins. bubblewrap: `--ro-bind root`, then `--bind` for each existing path;
later mounts cover earlier ones. See [jobs.md](jobs.md) and [bounded-changes.md](bounded-changes.md).

`ExecResult`: exit code, signal, stdout and stderr (`text`, `truncated`, `totalBytes`), `timedOut`,
`aborted`, `durationMs`.

## ProcessExecutor (`process.ts`)

The shared base class. Subclasses implement `launch(argv, policy, tracker?) → { file, args }`, and
optionally `track(policy)` (0.17, macOS: see "Escaped processes on macOS" below).

- `spawn` with `detached: true`: the command leads its own process group. A timeout, Ctrl-C (abort
  signal) or `shutdown()` signals the whole group: SIGTERM, then SIGKILL after 2 s. After the main
  process exits, the group gets SIGKILL too, so background children do not stay.
- Environment: only the allowlisted variables of Garuda's environment, plus `options.env`.
- Output: `OutputCapture` keeps the start and the end of each stream within `maxOutputBytes` and cuts
  the middle; the start shows what ran, the end shows how it finished.
- `start()` registers the process group in the same set, so `shutdown()` also stops MCP servers.
- With a tracker (0.17, Seatbelt with the helper): after the group kill, `run()` waits for
  `tracker.reap()` and adds `reaped` (processes killed) or `reapProblem` to the result; `start()` reaps
  when the process exits; `shutdown()` reaps every open tracker synchronously and removes the markers
  folder. A launch that throws removes its markers.

## Executors

| Executor | Platform | Launch |
| --- | --- | --- |
| `HostExecutor` | any | The program itself. Isolation `none`: every command asks for approval, unless an allow rule covers it. |
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
(deny lsopen)                                      ; 0.14: no apps through LaunchServices (`open`)
(deny appleevent-send)                             ; 0.14: no Apple Events (`osascript`)
(deny network-outbound (remote ip "*:*"))          ; when network is false
(deny network-inbound (local ip "*:*"))
(deny network-bind (local ip "*:*"))
(allow network-* … "localhost:*")                  ; test servers keep working
(deny file-read* (literal <markerA>))              ; 0.17: the tracker's markers, last (see below)
(allow file-read* (literal <markerB>))
(deny file-write* (subpath <markers folder>))
```

Paths are Scheme strings with `\` and `"` escaped.

### Escaped processes on macOS (`reaper.ts`, `native/garuda-reap.c`, 0.17)

IPI-04: Seatbelt has no process namespace. A process can leave the command's process group with
`setsid`, `setpgid`, or `posix_spawn` with `POSIX_SPAWN_SETSID` or `POSIX_SPAWN_SETPGROUP` (Node's
`spawn(..., { detached: true })` uses the last), and the group kill misses it. It stays inside the
sandbox, but it outlives the command. Probes on macOS 27 (2026-10-24) showed:

- a Seatbelt rule that denies the `setsid` and `setpgid` system calls blocks only those two ways, not
  the `posix_spawn` flags, and it breaks Python's `start_new_session`;
- `ps -E` shows no environment of other processes, so an environment token cannot find them;
- `sandbox_check(pid, "file-read-data", SANDBOX_FILTER_PATH, path)` works on other processes of
  the same user, with no privilege, for paths that exist (a missing path reads as denied for every
  process).

A process cannot leave its Seatbelt profile. So each sandboxed command gets two marker files (A and
B, random names) in a folder that the `Reaper` makes in the temp folder at the first command. The
profile denies reads of A, allows reads of B, and denies writes to the folder (the last matching rule
wins, so the command cannot delete its markers although the temp folder is writable). After the
command, the helper `native/bin/garuda-reap A B` lists every process of the user
(`proc_listallpids`, `proc_pidinfo`), and sends SIGKILL to each one with A denied and B allowed.
Processes without a sandbox allow both; App Store sandboxes deny both (the markers are outside their
containers); the profiles of other commands deny other markers. It scans again until a scan finds no
new process (at most 10), so children started during a scan are found too. It refuses to run when a
marker is missing (exit 3). On the user's Mac: four ways out (fork + setsid, posix_spawn with SETSID
and a cleared environment, with SETPGROUP and closed descriptors, Node's detached spawn) were all
found and killed, no other process matched (259 sandboxed processes were excluded), and one scan took
12 ms.

The helper is a universal arm64 + x86_64 binary with an ad-hoc signature, built by
`scripts/build-native.mjs` (clang; `pnpm build` and `pnpm test` run it on macOS, and rebuild it when
the source is newer). The release workflow builds it on a Mac (`--require`) and the npm package holds
it; it is not in git. `locateHelper()` looks for `native/bin/garuda-reap` up from the module. The
standalone binary (`pnpm package`) has none.

The bash tool tells the model when Garuda killed such processes, or when the check failed.

### bubblewrap arguments (`bwrapArgv`)

```text
--ro-bind / /  --dev /dev
--bind <p> <p>               for each existing write path
--ro-bind <p> <p>            for each existing protected path
--tmpfs <dir> --remount-ro <dir>   or   --ro-bind /dev/null <file>   for each denied read path
--unshare-net                when network is false (only a loopback interface)
--unshare-pid --proc /proc   always (0.14): its own process space and /proc
--die-with-parent --chdir <root> -- <argv>
```

An app that LaunchServices or Apple Events starts is a child of launchd, not of the command, so it
would run outside the sandbox: the two deny rules close that (0.14, review).

`--unshare-pid` (0.14, review): the command sees only its own processes, not Garuda's or the user's
(their command lines and environments in /proc). bwrap stays in Garuda's process group on the host and is
pid 1 inside, so the group kill still stops every process in the sandbox. A pid that the command prints
(`$!`) is a number from inside the sandbox; the contract tests find a background child by a unique
`sleep` time with a host `pgrep` instead. No `--new-session`: the command stays in Garuda's process
group, so a timeout or Ctrl-C reaches it. Limit: bubblewrap needs each mount point to exist, so a protected
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

`findOsSandbox()` caches the probe result per process, but each call returns a new executor
(0.14.1). An executor's `shutdown()` kills its running commands and daemons, so each `Runtime` must
own its executor: before 0.14.1 all runtimes shared one, and an eval task that ended killed the
commands and checks of the other tasks of `--parallel` (SIGKILL, no output).

The probes:
- On macOS without the helper (0.17), the sandbox works but a process that leaves the group can
  outlive its command: `auto` and `os` use Seatbelt with the notice `HELPER_MISSING`; the strict
  profile refuses with `StrictProfileError`.
- On macOS, `/usr/bin/sandbox-exec` must exist, and a probe
  (`sandbox-exec -p '(version 1)(allow default)' -- true`) must succeed (0.14). It fails, for example,
  in a nested sandbox; then `auto` uses `HostExecutor` with a notice that gives the first line of the
  error.
- On Linux, `bwrap` must be on `PATH` and a probe (`bwrap --ro-bind / / --dev /dev --unshare-net … true`)
  must succeed, because user namespaces can be off.

## Background daemons (`daemon.ts`, 0.14)

Only with `daemons.enabled: true` (off by default). Then `bash` accepts `is_daemon: true` and the
`process_manager` tool is registered.

- `DaemonManager` is created by the executor and tracks the daemons of this session only.
- A daemon starts with `executor.start(["bash", "-c", command], policy, env)`: the same sandbox and
  environment rules as any command. Its stdin is closed at once.
- Each daemon has an id (`daemon_1`, …), the PID, the command, start and end time, exit code or
  signal, and a status: `running`, `stopped` or `failed`.
- Output is split into lines and kept in memory: the newest `DEFAULT_MAX_LOG_LINES` (2,000) lines,
  each cut at `MAX_LOG_LINE_CHARS` (4,000). Text with no newline is kept as a line when it passes
  `MAX_PENDING_CHARS` (64,000), so memory stays bounded.
- API: `spawn(command, policy, {env?, maxBufferLines?})`, `list()`, `get(id)`,
  `logs(id, {lines?, stream?})` (default 50 lines; at most `MAX_LOGS_CHARS`, 30,000 characters, newest
  lines first kept), `kill(id)` and `shutdown()`.
- `kill` and `shutdown` call `RunningProcess.stop()`: SIGTERM to the process group, then SIGKILL
  after the grace time. `kill` marks the daemon `stopRequested`; its status becomes `stopped` when it
  has really ended (0.14, review), whatever the exit code.
- `Runtime.close()` calls `executor.daemons?.shutdown()`, so no daemon outlives the session.

## Tests

`test/executorContract.ts` is one suite that every executor must pass: output, exit code, working folder,
environment allowlist, output cap, timeout, `shutdown()` (the child, and since the Codex review of
1370184 also the shell and any sandbox wrapper: `shellRunning`), process-tree kill on abort, and (0.14, review)
a command that returns although a background child keeps its output open: after the command's own
process exits, `run()` waits at most `EXIT_DRAIN_MS` (2 s) for the pipes, then kills the group, closes
the pipes and returns; the timeout and Ctrl-C now signal the group even after bash has exited. Since
0.14 `proxyEnv` builds `MAVEN_OPTS`/`GRADLE_OPTS` from the allowlisted environment only.
`test/hostExecutor.test.ts` runs it for the host; `test/sandbox.test.ts` runs it for the machine's OS
sandbox, plus real checks: writes outside the root fail, protected paths stay read-only, denied reads
fail, no network, and `sandbox: false` isolates nothing. The Seatbelt tests run only on macOS.
`test/reaper.test.ts` (0.17) tests the markers and their profile rules, the executor wiring with a
fake helper (reap after `run()` and after a started process exits, `reapProblem`, `shutdown()`), and
the selection without the helper (notice; strict refuses); on macOS it runs the real helper: a
process that left the group by `setsid` and one by Node's detached spawn are killed (control: without
the helper they outlive the command), and an unsandboxed process survives the scan.
`test/daemon.test.ts` (0.14) tests daemon launch, log capture, status, kill, the log caps, that the
setting is off by default, and that `Runtime.close()` stops a running daemon.
`test/networkProxy.test.ts` (0.13) tests the allowlist, the proxy (tunnel, 403 with the reason, IP
literals, private addresses, plain http) and curl through the machine's OS sandbox with and without the
proxy; `test/network.test.ts` the runtime (consent, pinning, questions, ports), evals and jobs.
