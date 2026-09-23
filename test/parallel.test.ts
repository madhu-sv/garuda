import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { addUserMessage, createSession } from "../src/session/session.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";

/** Tools that record when they start and end, so the test can see overlap. */
function tracker() {
  const log: string[] = [];
  let running = 0;
  let maxRunning = 0;
  const make = (name: string, readOnly: boolean): Tool<{ id: string }> => ({
    name,
    description: name,
    inputSchema: z.object({ id: z.string() }),
    readOnly,
    async run({ id }) {
      running++;
      maxRunning = Math.max(maxRunning, running);
      log.push(`start ${id}`);
      await new Promise((r) => setTimeout(r, 20));
      log.push(`end ${id}`);
      running--;
      return id;
    },
  });
  return {
    log,
    maxRunning: () => maxRunning,
    read: make("read", true),
    write: make("write", false),
  };
}

describe("tool scheduling (F8)", () => {
  it("runs read-only calls in parallel and other calls one at a time, in order", async () => {
    const t = tracker();
    const model = new FakeModelClient([
      reply([
        toolUse("read", { id: "r1" }, "a"),
        toolUse("read", { id: "r2" }, "b"),
        toolUse("write", { id: "w1" }, "c"),
        toolUse("write", { id: "w2" }, "d"),
        toolUse("read", { id: "r3" }, "e"),
      ]),
      reply([text("done")]),
    ]);
    const session = createSession("/tmp");
    addUserMessage(session, "go");
    await runAgent(session, { model, tools: new ToolRegistry([t.read, t.write]), system: "s" });

    // r1 and r2 overlap. w1, w2 and r3 each run alone, after the one before.
    expect(t.log.slice(0, 2).sort()).toEqual(["start r1", "start r2"]);
    expect(t.log.slice(4)).toEqual([
      "start w1",
      "end w1",
      "start w2",
      "end w2",
      "start r3",
      "end r3",
    ]);
    expect(t.maxRunning()).toBe(2);

    // Results keep the call order.
    const results = session.messages[2]?.content ?? [];
    expect(results.map((b) => b.type === "tool_result" && b.toolUseId)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(results.map((b) => b.type === "tool_result" && b.content)).toEqual([
      "r1",
      "r2",
      "w1",
      "w2",
      "r3",
    ]);
  });
});
