import { existsSync, statSync } from "node:fs";
import { type Launch, ProcessExecutor, plain } from "./process.js";
import { homeIsWritable, scopeBases } from "./readScope.js";
import type { ExecPolicy } from "./types.js";

/**
 * The Linux sandbox: bubblewrap. The whole file system is mounted read-only,
 * then `writePaths` are mounted writable again. In "needed" mode (T15) the home folder and other
 * volumes are empty first, with only the readable paths mounted back. Denied read paths are covered with an
 * empty folder or /dev/null. --unshare-net leaves only a loopback interface, and --unshare-pid
 * gives the command its own process space.
 */
export class BwrapExecutor extends ProcessExecutor {
  readonly name = "bwrap";
  readonly isolation = "os" as const;

  constructor(private readonly bwrap: string) {
    super();
  }

  protected launch(argv: string[], policy: ExecPolicy): Launch {
    if (!policy.sandbox) return plain(argv);
    return { file: this.bwrap, args: bwrapArgv(argv, policy) };
  }
}

/**
 * bubblewrap needs each mount point to exist, so paths that do not exist are skipped.
 * Limit: a protected path that does not exist yet (for example .git/hooks in a folder
 * with no .git) is not protected. Seatbelt has no such limit.
 */
export function bwrapArgs(
  command: string,
  policy: ExecPolicy,
  kind: (path: string) => "dir" | "file" | undefined = pathKind,
): string[] {
  return bwrapArgv(["bash", "-c", command], policy, kind);
}

export function bwrapArgv(
  argv: string[],
  policy: ExecPolicy,
  kind: (path: string) => "dir" | "file" | undefined = pathKind,
): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev"];
  // Later mounts cover earlier ones: writable paths, then read-only holes, then hidden paths.
  // Reads only where needed (T15): write paths outside the home folder and the hidden places
  // first (a writable parent such as the temp folder must not cover them), then those folders
  // empty, the readable paths read-only again, then the write paths inside them. bubblewrap
  // makes the mount points in the empty folders.
  const hidden = hiddenBases(policy, kind);
  const inHidden = (path: string) => hidden.some((b) => path === b || path.startsWith(`${b}/`));
  for (const path of policy.writePaths)
    if (!inHidden(path) && kind(path) !== undefined) args.push("--bind", path, path);
  for (const base of hidden) args.push("--tmpfs", base);
  if (hidden.length > 0 && policy.reads !== undefined) {
    // Only inside the emptied folders: a read-only mount elsewhere would cover a write path there
    // (the baseline's program in /tmp did, 0.20.0).
    for (const path of policy.reads.allow)
      if (inHidden(path) && kind(path) !== undefined) args.push("--ro-bind", path, path);
  }
  for (const path of policy.writePaths)
    if (inHidden(path) && kind(path) !== undefined) args.push("--bind", path, path);
  // The staging copy over the project (0.17, review T5): the command sees the project's paths,
  // but every write goes to the copy. The holes below then apply inside the copy.
  for (const mount of policy.mounts ?? []) args.push("--bind", mount.source, mount.target);
  if (policy.writeScope !== undefined) {
    // A job's write scope (0.17): the root read-only, then its scope paths writable; the holes
    // and hidden paths below come after, so they still cover paths in a scope folder.
    args.push("--ro-bind", policy.writeScope.root, policy.writeScope.root);
    for (const path of policy.writeScope.paths)
      if (kind(path) !== undefined) args.push("--bind", path, path);
  }
  for (const path of policy.denyWritePaths) {
    if (kind(path) !== undefined) args.push("--ro-bind", path, path);
  }
  for (const path of policy.denyReadPaths) {
    const k = kind(path);
    if (k === "dir") args.push("--tmpfs", path, "--remount-ro", path);
    else if (k === "file") args.push("--ro-bind", "/dev/null", path);
  }
  // The empty folders read-only last (T15): a write to an unlisted home path fails, as before,
  // and does not land in a tmpfs that vanishes. The mounts inside keep their own flags.
  for (const base of hidden) args.push("--remount-ro", base);
  if (!policy.network) args.push("--unshare-net");
  // Its own process space and /proc (0.14, review): the command sees only its own processes, not
  // Garuda's or the user's. bwrap stays in Garuda's process group on the host, and it is pid 1
  // inside, so stopping it ends every process in the sandbox, also one in its own session.
  args.push("--unshare-pid", "--proc", "/proc");
  const run = policy.sandbox && !policy.network ? withBridge(argv, policy) : argv;
  // No --new-session: the command stays in Garuda's process group, so a timeout or Ctrl-C reaches it.
  args.push("--die-with-parent", "--chdir", policy.root, "--", ...run);
  return args;
}

/**
 * The bridge in the network namespace (0.13): node forwards 127.0.0.1:<port> to Garuda's proxy
 * socket. It starts in the background with no output, the command waits until the port answers
 * (up to 2 s), and the executor kills the process group when the command ends.
 */
export const BRIDGE_JS =
  'const n=require("net");const[,s,p]=process.argv;n.createServer(c=>{const u=n.connect(s);c.pipe(u);u.pipe(c);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy())}).listen(+p,"127.0.0.1")';

const BRIDGE_WRAP =
  '"$1" -e "$2" "$3" "$4" </dev/null >/dev/null 2>&1 & for i in $(seq 200); do (: </dev/tcp/127.0.0.1/$4) 2>/dev/null && break; sleep 0.01; done; shift 4; exec "$@"';

function withBridge(argv: string[], policy: ExecPolicy): string[] {
  const proxy = policy.proxy;
  if (proxy?.bridge === undefined) return argv;
  return [
    "bash",
    "-c",
    BRIDGE_WRAP,
    "garuda-bridge",
    proxy.bridge,
    BRIDGE_JS,
    proxy.socketPath,
    String(proxy.port),
    ...argv,
  ];
}

/**
 * The folders that "needed" mode empties: the home folder and each hidden place that exists.
 * None when a write path opens the home folder itself (the user made all of it writable).
 */
function hiddenBases(
  policy: ExecPolicy,
  kind: (path: string) => "dir" | "file" | undefined,
): string[] {
  const scope = policy.reads;
  if (scope === undefined || homeIsWritable(scope, policy.writePaths)) return [];
  return scopeBases(scope).filter((base) => kind(base) === "dir");
}

function pathKind(path: string): "dir" | "file" | undefined {
  if (!existsSync(path)) return undefined;
  return statSync(path).isDirectory() ? "dir" : "file";
}
