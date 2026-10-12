import { describe, expect, it } from "vitest";
import { usageLine } from "../src/cli/report.js";
import { formatReport } from "../src/evals/runner.js";
import type { EvalResult } from "../src/evals/types.js";
import { runAgent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text } from "../src/model/fake.js";
import type { Price } from "../src/model/pricing.js";
import type { ModelClient, Usage } from "../src/model/types.js";
import { rebuildState } from "../src/session/resume.js";
import { addUnreported, addUserMessage, createSession } from "../src/session/session.js";
import { MemoryJournal } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { allowAll } from "./helpers.js";

/** One failed attempt must not hide the known cost (review of 1370184, finding 1). */

const price: Price = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
const usage = (inputTokens: number, outputTokens = 0): Usage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** A transient failure (529) first, then a normal answer. */
function flaky(): ModelClient {
  let calls = 0;
  const fine = new FakeModelClient([reply([text("ok")], undefined, usage(1_000_000))]);
  return {
    async *stream(request, options) {
      calls++;
      if (calls === 1) throw Object.assign(new Error("overloaded"), { status: 529 });
      yield* fine.stream(request, options);
    },
  };
}

describe("a known cost, marked incomplete", () => {
  it("one 529, then success: the cost stays known as a minimum, and is marked incomplete", async () => {
    const journal = new MemoryJournal();
    const session = createSession("/tmp/p", "s", journal);
    addUserMessage(session, "go");
    const result = await runAgent(session, {
      model: flaky(),
      tools: new ToolRegistry(),
      system: "s",
      permissions: allowAll(),
      maxTokens: 100,
      price,
      retryDelaysMs: [0],
    });
    expect(result.stopReason).toBe("done");
    expect(session.unreportedTokens).toBeGreaterThan(0);
    expect(session.costUsd).toBeCloseTo(1);
    expect(session.costIncomplete).toBe(true);
    // Resume gives the same.
    const state = rebuildState(journal.records);
    expect(state.costUsd).toBeCloseTo(1);
    expect(state.costIncomplete).toBe(true);
  });

  it("a later turn with full usage adds its exact cost to the minimum", () => {
    const session = createSession("/tmp/p", "s2");
    addUnreported(session, 500);
    expect(session.costUsd).toBe(0);
    expect(session.costIncomplete).toBe(true);
  });

  it("the usage line says the cost is a minimum", () => {
    const session = createSession("/tmp/p", "s3");
    session.costUsd = 0.5;
    addUnreported(session, 500);
    const line = usageLine(
      { stopReason: "done", steps: 1, usage: usage(10), apiMs: 0 },
      session,
      0.25,
      200_000,
      true,
    );
    expect(line).toContain("≥ $0.25 (incomplete)");
    expect(line).toContain("≥ $0.50 (incomplete)");
  });

  it("evals: one incomplete run gives a minimum, not 'unknown'", () => {
    const row = (costUsd: number, costIncomplete: boolean): EvalResult =>
      ({
        id: "t",
        passed: true,
        scored: true,
        steps: 1,
        tokens: 10,
        costUsd,
        ...(costIncomplete ? { costIncomplete: true, unreportedTokens: 5 } : {}),
        durationMs: 1,
        stopReason: "done",
      }) as unknown as EvalResult;
    const report = formatReport([row(0.5, false), row(0.25, true)]);
    expect(report).toContain("cost ≥ $0.7500 (incomplete)");
    expect(report).not.toContain("cost unknown");
  });
});
