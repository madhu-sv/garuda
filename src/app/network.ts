import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { describeAllowlist } from "../net/allowlist.js";
import type { ApprovalRequest } from "../permissions/types.js";
import type { Isolation } from "../sandbox/types.js";

/** The hash of a network allowlist that the user approved (0.13), for ~/.garuda/trust.json. */
export function networkHash(entries: readonly string[]): string {
  const canonical = [...new Set(entries.map((e) => e.trim().toLowerCase()))].sort();
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The note for the model (0.13): which hosts commands in the sandbox can reach. */
export function networkNote(entries: readonly string[]): string {
  return [
    "Commands in the sandbox can reach these hosts through Garuda's network proxy:",
    ...describeAllowlist(entries).map((line) => `  ${line}`),
    "Run commands that need them in the sandbox, as usual (installs, builds, `npm view` and the like). Do not use outside_sandbox for them.",
    "For any other host, also run the command in the sandbox: Garuda asks the user for that host, and the result says if it was blocked. Use outside_sandbox only when the sandbox blocks something else (a write outside the project).",
  ].join("\n");
}

/** The question before the proxy starts: the project's list, with each preset's hosts. */
export function networkConsent(
  entries: readonly string[],
  isolation: Isolation,
  changed: boolean,
): ApprovalRequest {
  const lines = [
    changed
      ? "The network allowlist in .garuda/settings.json changed since you allowed it."
      : "This project's .garuda/settings.json opens the network for commands in the sandbox.",
    "Commands may reach these hosts through Garuda's proxy, with no question:",
    ...describeAllowlist(entries).map((line) => `  ${line}`),
    "Any other host asks you first (jobs and evals deny it). Only ports 80 and 443.",
    "A command could send project files to these hosts. Allow them only if you trust this project.",
  ];
  return {
    tool: "network",
    target: { kind: "input", json: JSON.stringify({ allow: entries }) },
    preview: lines.join("\n"),
    isolation,
    title: "Open the network for commands?",
    labels: {
      once: "Yes, for this session only",
      session: "Yes, and remember (asks again if the list changes)",
      deny: "No, commands keep no network",
    },
  };
}

/**
 * A node binary for the bridge into bubblewrap's network namespace: this process when it is node,
 * else the first `node` on the PATH. Undefined when there is none (the standalone binary with no
 * node installed).
 */
export function nodeBinary(
  execPath: string = process.execPath,
  path: string = process.env.PATH ?? "",
): string | undefined {
  if (/^node(\.exe)?$/.test(basename(execPath))) return execPath;
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "node");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
