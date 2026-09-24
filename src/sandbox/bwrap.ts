import { existsSync, statSync } from "node:fs";
import { type Launch, ProcessExecutor, plain } from "./process.js";
import type { ExecPolicy } from "./types.js";

/**
 * The Linux sandbox: bubblewrap. The whole file system is mounted read-only,
 * then `writePaths` are mounted writable again. Denied read paths are covered with an
 * empty folder or /dev/null. --unshare-net leaves only a loopback interface.
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
  for (const path of policy.writePaths)
    if (kind(path) !== undefined) args.push("--bind", path, path);
  for (const path of policy.denyWritePaths) {
    if (kind(path) !== undefined) args.push("--ro-bind", path, path);
  }
  for (const path of policy.denyReadPaths) {
    const k = kind(path);
    if (k === "dir") args.push("--tmpfs", path, "--remount-ro", path);
    else if (k === "file") args.push("--ro-bind", "/dev/null", path);
  }
  if (!policy.network) args.push("--unshare-net");
  // No --new-session and no --unshare-pid: the command stays in Garuda's process group,
  // so a timeout or Ctrl-C kills the whole tree, and pids stay the same as on the host.
  args.push("--die-with-parent", "--chdir", policy.root, "--", ...argv);
  return args;
}

function pathKind(path: string): "dir" | "file" | undefined {
  if (!existsSync(path)) return undefined;
  return statSync(path).isDirectory() ? "dir" : "file";
}
