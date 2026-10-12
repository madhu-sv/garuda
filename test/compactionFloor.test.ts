import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { Usage } from "../src/model/types.js";
import { addUserMessage, createSession } from "../src/session/session.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";
import { allowAll } from "./helpers.js";

/**
 * Codex review of 1370184 (P3): while tools run, the parent keeps a floor that children cannot
 * reserve. When a compaction is due before the next request, its summary request also needs room;
 * before, the floor left it out, so a child could take the tokens and the turn stopped.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "garuda-compaction-floor-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const usage = (inputTokens: number, outputTokens = 0): Usage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** A tool that measures the largest reservation a child could make now. */
function probe(found: { left: number; child: number }): Tool<Record<string, never>> {
  return {
    name: "probe",
    description: "Measure the child room.",
    inputSchema: z.object({}),
    readOnly: true,
    async run(_input, context) {
      const budget = context.budget;
      if (budget === undefined) throw new Error("no budget");
      let low = 0;
      let high = budget.left;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const view = budget.child(Number.MAX_SAFE_INTEGER);
        const hold = view.reserve(mid);
        if (hold === undefined) high = mid - 1;
        else {
          view.settle(hold, 0);
          low = mid;
        }
      }
      found.left = budget.left;
      found.child = low;
      return "measured";
    },
  };
}

describe("the parent's floor while tools run", () => {
  it("also covers a compaction that is due before the next request", async () => {
    const context = 1_000_000;
    const found = { left: 0, child: 0 };
    const model = new FakeModelClient([
      reply([toolUse("probe", {})], undefined, usage(context, 10)),
      reply([text("summary")], undefined, usage(10, 10)),
      reply([text("final")], undefined, usage(10, 10)),
    ]);
    const session = createSession(root, "floor");
    addUserMessage(session, "go");
    await runAgent(session, {
      model,
      tools: new ToolRegistry([probe(found)]),
      system: "s",
      permissions: allowAll(root),
      tokenBudget: 10_000_000,
      maxTokens: 200,
      contextWindow: 1_100_000,
    });
    const floor = found.left - found.child;
    // The summary request reserves at least the context before compaction plus its output limit
    // (4,096), and the next request still needs its own room.
    expect(floor).toBeGreaterThanOrEqual(context + 4_096 + context + 200);
  });

  it("with no compaction due, the floor stays the next request only", async () => {
    const found = { left: 0, child: 0 };
    const model = new FakeModelClient([
      reply([toolUse("probe", {})], undefined, usage(1_000, 10)),
      reply([text("final")], undefined, usage(10, 10)),
    ]);
    const session = createSession(root, "small");
    addUserMessage(session, "go");
    await runAgent(session, {
      model,
      tools: new ToolRegistry([probe(found)]),
      system: "s",
      permissions: allowAll(root),
      tokenBudget: 10_000_000,
      maxTokens: 200,
      contextWindow: 1_100_000,
    });
    // The next request: the context, a bounded tool result (100,000 characters, worst-case
    // escaping) and the output limit. No summary room.
    expect(found.left - found.child).toBeLessThan(1_000 + 160_000 + 200);
  });
});
