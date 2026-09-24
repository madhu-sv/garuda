import { type Launch, ProcessExecutor, plainBash } from "./process.js";
import type { ExecPolicy } from "./types.js";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * The macOS sandbox: Seatbelt through sandbox-exec. The profile allows everything,
 * then denies writes outside `writePaths`, reads of `denyReadPaths` and IP networking.
 * In Seatbelt profiles the last matching rule wins, so the order of the rules matters.
 */
export class SeatbeltExecutor extends ProcessExecutor {
  readonly name = "seatbelt";
  readonly isolation = "os" as const;

  protected launch(command: string, policy: ExecPolicy): Launch {
    if (!policy.sandbox) return plainBash(command);
    return { file: SANDBOX_EXEC, args: ["-p", seatbeltProfile(policy), "bash", "-c", command] };
  }
}

export function seatbeltProfile(policy: ExecPolicy): string {
  const paths = (list: readonly string[]) => list.map((p) => `(subpath ${quote(p)})`).join(" ");
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${paths(policy.writePaths)} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
  ];
  if (policy.denyWritePaths.length > 0) {
    lines.push(`(deny file-write* ${paths(policy.denyWritePaths)})`);
  }
  if (policy.denyReadPaths.length > 0) {
    lines.push(`(deny file-read* ${paths(policy.denyReadPaths)})`);
  }
  if (!policy.network) {
    // No IP network, except localhost: test suites often start and call a local server.
    lines.push(
      '(deny network-outbound (remote ip "*:*"))',
      '(deny network-inbound (local ip "*:*"))',
      '(deny network-bind (local ip "*:*"))',
      '(allow network-outbound (remote ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-bind (local ip "localhost:*"))',
    );
  }
  return lines.join("\n");
}

/** A Seatbelt (Scheme) string literal. */
function quote(path: string): string {
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
