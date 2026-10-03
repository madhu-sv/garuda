import { Writable } from "node:stream";
import { z } from "zod";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { FileTracker } from "../src/session/fileTracker.js";
import type { Tool, ToolContext } from "../src/tools/types.js";

/** A test tool that returns its input text in upper case. */
export function upperTool(calls: string[] = []): Tool<{ text: string }> {
  return {
    name: "upper",
    description: "Return the text in upper case.",
    inputSchema: z.object({ text: z.string() }),
    readOnly: true,
    async run({ text }) {
      calls.push(text);
      return text.toUpperCase();
    },
  };
}

/** A test tool that always throws. */
export const failTool: Tool<Record<string, never>> = {
  name: "fail",
  description: "Always fails.",
  inputSchema: z.object({}),
  readOnly: true,
  async run() {
    throw new Error("disk on fire");
  },
};

/** A permission engine that approves every call once. */
export function allowAll(root = "/tmp"): PermissionEngine {
  return new PermissionEngine({ root, approver: new AutoApprover("once") });
}

/** A tool context for direct registry calls. */
export function toolContext(root: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    root,
    signal: new AbortController().signal,
    permissions: allowAll(root),
    files: new FileTracker(),
    ...overrides,
  };
}

/**
 * A stream that keeps what is written, in order. Use it instead of reading a PassThrough:
 * `read()` returns one chunk or all of them, depending on the Node version.
 */
export function sink(): { stream: Writable; text: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  return { stream, text: () => text };
}

/**
 * A sleep time that names one test's background child. A pid from `$!` does not work: in a
 * sandbox with its own process space it is a number from inside that space (0.14, review).
 */
export function uniqueSleep(): string {
  return `30.${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}1`;
}

/** Whether the background child still runs, seen from the host with pgrep. */
export async function sleeping(marker: string, root: string): Promise<boolean> {
  const r = await new HostExecutor().run(
    `pgrep -f '^sleep ${marker}$' >/dev/null && echo yes || echo no`,
    {
      root,
      sandbox: false,
      writePaths: [],
      denyWritePaths: [],
      denyReadPaths: [],
      network: true,
      envAllowlist: ["PATH"],
      timeoutMs: 5_000,
      maxOutputBytes: 1_000,
    },
  );
  return r.stdout.text.trim() === "yes";
}

export async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
