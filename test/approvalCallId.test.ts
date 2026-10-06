import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runTools } from "../src/loop/toolRunner.js";
import type { ToolUseBlock } from "../src/model/types.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../src/permissions/types.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";
import { toolContext } from "./helpers.js";

/**
 * The approval question names its tool call (0.15). Read-only calls run in parallel, so a front
 * end that shows each question next to its tool call (ACP) cannot guess the call from the order.
 */

/** A read-only tool whose call counts as a change, so it asks, and still runs in parallel. */
const askingTool: Tool<{ name: string }> = {
  name: "ask_me",
  description: "A read-only tool that asks for each call.",
  inputSchema: z.object({ name: z.string() }),
  readOnly: true,
  async describe({ name }) {
    return { target: { kind: "path", path: `${name}.txt` }, mutates: true };
  },
  async run({ name }) {
    return `ran ${name}`;
  },
};

/** Holds every question until both are open, so the two calls really ask at the same time. */
class HoldingApprover implements Approver {
  readonly asked: { callId: string | undefined; target: string }[] = [];
  private release: (() => void) | undefined;
  private readonly bothOpen = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  async ask(request: ApprovalRequest): Promise<ApprovalChoice> {
    const target = request.target.kind === "path" ? request.target.path : "";
    this.asked.push({ callId: request.callId, target });
    if (this.asked.length === 2) this.release?.();
    await this.bothOpen;
    return "once";
  }
}

const call = (id: string, name: string): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "ask_me",
  input: { name },
});

describe("approval questions name their tool call (0.15)", () => {
  it("two parallel calls that both ask get their own call id", async () => {
    const approver = new HoldingApprover();
    const permissions = new PermissionEngine({ root: "/tmp", approver });
    const tools = new ToolRegistry([askingTool]);
    const { results } = await runTools(
      [call("call_a", "a"), call("call_b", "b")],
      { tools },
      toolContext("/tmp", { permissions }),
      () => {},
    );
    expect(results.map((r) => r.content)).toEqual(["ran a", "ran b"]);
    // Both questions were open at once, and each one carries the id of the call that asked.
    expect(approver.asked).toHaveLength(2);
    expect(approver.asked).toEqual(
      expect.arrayContaining([
        { callId: "call_a", target: "a.txt" },
        { callId: "call_b", target: "b.txt" },
      ]),
    );
  });
});
