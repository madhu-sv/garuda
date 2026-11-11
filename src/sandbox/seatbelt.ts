import { type Launch, ProcessExecutor, plain } from "./process.js";
import {
  homeIsWritable,
  type ReadScope,
  readAncestors,
  scopeBases,
  writableInScope,
} from "./readScope.js";
import type { Reaper, Tracker } from "./reaper.js";
import type { ExecPolicy } from "./types.js";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * The macOS sandbox: Seatbelt through sandbox-exec. The profile allows everything,
 * then denies writes outside `writePaths`, reads of `denyReadPaths`, IP networking, and
 * starting apps through LaunchServices or Apple Events.
 * In Seatbelt profiles the last matching rule wins, so the order of the rules matters.
 */
export class SeatbeltExecutor extends ProcessExecutor {
  readonly name = "seatbelt";
  readonly isolation = "os" as const;

  /**
   * `reaper` (0.17, IPI-04): finds and kills the processes that leave a command's process group.
   * Without it, such a process outlives the command (index.ts warns, or strict refuses).
   */
  constructor(readonly reaper?: Reaper) {
    super();
  }

  protected override track(policy: ExecPolicy): Tracker | undefined {
    return policy.sandbox && this.reaper !== undefined ? this.reaper.track() : undefined;
  }

  protected override closeTracking(): void {
    this.reaper?.close();
  }

  protected launch(argv: string[], policy: ExecPolicy, tracker?: Tracker): Launch {
    if (!policy.sandbox) return plain(argv);
    // Seatbelt cannot mount a folder over another (staged mode uses a working root of its own).
    if ((policy.mounts ?? []).length > 0) throw new Error("Seatbelt cannot mount folders.");
    return {
      file: SANDBOX_EXEC,
      args: ["-p", seatbeltProfile(policy, tracker?.rules), ...argv],
    };
  }
}

/** The simulator's service stays out of reach (0.20.1, docs/lld/mobile.md). */
export const SIMULATOR_RULE =
  '(deny mach-lookup (global-name-regex #"^com\\.apple\\.CoreSimulator\\."))';

/** The profile; `extra` (the markers of IPI-04) goes last, so it wins over the rules above. */
export function seatbeltProfile(policy: ExecPolicy, extra: readonly string[] = []): string {
  const paths = (list: readonly string[]) => list.map((p) => `(subpath ${quote(p)})`).join(" ");
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${paths(policy.writePaths)} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
  ];
  if (policy.writeScope !== undefined) {
    // A job's write scope (0.17): the root read-only, then its scope paths writable. The last
    // matching rule wins, so the denied paths below stay denied inside a scope folder.
    lines.push(`(deny file-write* ${paths([policy.writeScope.root])})`);
    if (policy.writeScope.paths.length > 0) {
      lines.push(`(allow file-write* ${paths(policy.writeScope.paths)})`);
    }
  }
  if (policy.denyWritePaths.length > 0) {
    lines.push(`(deny file-write* ${paths(withDataVolume(policy.denyWritePaths))})`);
  }
  if (policy.reads !== undefined) lines.push(...readRules(policy.reads, policy.writePaths));
  if (policy.denyReadPaths.length > 0) {
    lines.push(`(deny file-read* ${paths(withDataVolume(policy.denyReadPaths))})`);
  }
  // No apps through LaunchServices (`open`) or Apple Events (`osascript`) (0.14, review): an app
  // started that way runs outside the sandbox, with the user's full rights.
  lines.push("(deny lsopen)", "(deny appleevent-send)");
  if (!policy.network) {
    // No IP network, except localhost: test suites often start and call a local server.
    lines.push(
      '(deny network-outbound (remote ip "*:*"))',
      '(deny network-inbound (local ip "*:*"))',
      '(deny network-bind (local ip "*:*"))',
      '(allow network-outbound (remote ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-bind (local ip "localhost:*"))',
      // No port rule for adb (localhost:5037) here: after these rules Seatbelt then denied all of
      // localhost (the user's test, 0.20.1), and the proxy and local test servers failed. A
      // sandboxed command can reach an adb server that the user started (docs/lld/mobile.md).
    );
  }
  // No simulator control (0.20.1, docs/lld/mobile.md): CoreSimulator's service runs outside the
  // sandbox with the user's rights. In the user's probes a sandboxed `simctl` read a hidden file
  // (`addmedia`) and wrote one in the home folder (`io screenshot`). With the user's yes,
  // `outside_sandbox` still runs it.
  lines.push(SIMULATOR_RULE);
  lines.push(...extra);
  return lines.join("\n");
}

/**
 * Reads only where needed (T15, docs/lld/reads.md): the home folder and the hidden places denied,
 * then the readable paths (and the write paths there) allowed again, then a metadata-only rule for
 * the folders on the way to them. The last matching rule wins, so the deny list that follows still
 * wins inside a readable folder. A write path that opens the home folder itself turns this off.
 */
export function readRules(scope: ReadScope, writePaths: readonly string[]): string[] {
  if (homeIsWritable(scope, writePaths)) return [];
  const paths = (list: readonly string[]) =>
    withDataVolume(list)
      .map((p) => `(subpath ${quote(p)})`)
      .join(" ");
  const literals = (list: readonly string[]) =>
    withDataVolume(list)
      .map((p) => `(literal ${quote(p)})`)
      .join(" ");
  const readable = [...new Set([...scope.allow, ...writableInScope(scope, writePaths)])];
  const lines = [`(deny file-read* ${paths(scopeBases(scope))})`];
  if (readable.length > 0) lines.push(`(allow file-read* ${paths(readable)})`);
  const ancestors = readAncestors(scope, readable);
  if (ancestors.length > 0) lines.push(`(allow file-read-metadata ${literals(ancestors)})`);
  return lines;
}

/**
 * Each path under /Users also under /System/Volumes/Data/Users (0.18.1): macOS reaches the same
 * folder through that firmlink, and a model in an eval read the user's checkout that way. A deny
 * rule names both, so neither path gets past it.
 */
export function withDataVolume(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of list) {
    out.push(path);
    if (path.startsWith("/Users/")) out.push(`/System/Volumes/Data${path}`);
  }
  return out;
}

/** A Seatbelt (Scheme) string literal. */
function quote(path: string): string {
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
