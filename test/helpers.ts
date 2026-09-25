import { Writable } from "node:stream";
import { z } from "zod";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
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
