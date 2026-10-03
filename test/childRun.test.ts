import { describe, expect, it } from "vitest";
import { type ChildRun, runChild } from "../src/agents/child.js";
import { SUMMARY_SYSTEM } from "../src/context/compact.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { ModelRequest, ModelResponse, Usage } from "../src/model/types.js";
import type { SessionRecord } from "../src/session/records.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { type AnyTool, SubagentFailure } from "../src/tools/types.js";
import { toolContext, upperTool } from "./helpers.js";

/** Subagent runs: usage, end records and failures (0.14.1, from Garuda's agents review). */

const usage = (inputTokens: number): Usage => ({
  inputTokens,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

function child(
  steps: ((request: ModelRequest) => ModelResponse)[],
  over: Partial<ChildRun> = {},
): { run: ChildRun; records: SessionRecord[] } {
  const records: SessionRecord[] = [];
  const model = new FakeModelClient(steps);
  return {
    records,
    run: {
      id: "explore-t1",
      system: "child system",
      prompt: "look around",
      tools: new ToolRegistry([upperTool()]),
      model: { spec: "fake", contextWindow: 100_000, client: async () => model },
      permissions: toolContext("/tmp").permissions,
      limits: { maxSteps: 10, tokenBudget: 1_000_000 },
      maxTokens: 100,
      journal: { write: (record) => records.push(record as SessionRecord) },
      ...over,
    },
  };
}

const ends = (records: SessionRecord[]) => records.filter((r) => r.type === "end");

describe("subagent runs (0.14.1, review)", () => {
  it("a run that fails part way still reports its usage, and the registry adds it", async () => {
    const { run, records } = child([
      () => reply([toolUse("upper", { text: "a" }, "u1")], undefined, usage(700)),
      () => {
        throw new Error("the provider refused the request");
      },
    ]);
    const error = await runChild(run, toolContext("/tmp")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubagentFailure);
    const report = (error as SubagentFailure).report;
    expect(report.usage.inputTokens).toBe(700);
    expect(report.stopReason).toBe("error");
    expect(ends(records)).toEqual([expect.objectContaining({ stopReason: "error", steps: 1 })]);

    // Through the registry: an error result that still carries the report.
    const again = child([
      () => reply([toolUse("upper", { text: "a" }, "u1")], undefined, usage(700)),
      () => {
        throw new Error("the provider refused the request");
      },
    ]);
    const tool: AnyTool = {
      name: "explore",
      description: "test",
      inputSchema: (await import("zod")).z.object({}),
      readOnly: true,
      run: async (_input, context) => runChild(again.run, context),
    };
    const outcome = await new ToolRegistry([tool]).execute(
      { type: "tool_use", id: "e1", name: "explore", input: {} },
      toolContext("/tmp"),
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.subagent?.usage.inputTokens).toBe(700);
  });

  it("writes one end record, also after a wrap-up call", async () => {
    const { run, records } = child(
      [() => reply([toolUse("upper", { text: "a" }, "u1")]), () => reply([text("What I found.")])],
      { limits: { maxSteps: 1, tokenBudget: 1_000_000 } },
    );
    const result = await runChild(run, toolContext("/tmp"));
    expect(result.answer).toBe("What I found.");
    expect(ends(records)).toEqual([expect.objectContaining({ stopReason: "wrap_up", steps: 2 })]);
  });

  it("the report counts the tokens of a compaction summary", async () => {
    // Each main call reports a nearly full window, so the child compacts after a few steps.
    let main = 0;
    let summaries = 0;
    const step = (request: ModelRequest): ModelResponse => {
      if (request.system === SUMMARY_SYSTEM) {
        summaries++;
        return reply([text("Summary of the early steps.")], "end_turn", usage(5_000));
      }
      main++;
      return main < 8
        ? reply([toolUse("upper", { text: `t${main}` }, `u${main}`)], undefined, usage(900))
        : reply([text("Done.")], "end_turn", usage(100));
    };
    const { run } = child(
      Array.from({ length: 12 }, () => step),
      {
        model: {
          spec: "fake",
          contextWindow: 1_000,
          client: async () => new FakeModelClient(Array.from({ length: 12 }, () => step)),
        },
      },
    );
    const result = await runChild(run, toolContext("/tmp"));
    expect(summaries).toBeGreaterThan(0);
    const mainTokens = 7 * 900 + 100;
    expect(result.report.usage.inputTokens).toBe(mainTokens + summaries * 5_000);
  });
});
