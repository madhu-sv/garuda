import { describe, expect, it } from "vitest";
import { resultLine } from "../src/cli/jsonOutput.js";
import { ZERO_USAGE } from "../src/model/types.js";

/** JSON output: an unknown or partial cost is never just a number (review of 1370184, finding 2). */

const base = {
  model: "m",
  durationMs: 1,
  lastText: "ok",
  denials: [],
  contextWindow: 100_000,
  maxOutputTokens: 900,
};
const done = {
  kind: "done" as const,
  result: { stopReason: "done" as const, steps: 1, usage: ZERO_USAGE, apiMs: 0 },
};

describe("JSON cost fields", () => {
  it("a known minimum carries flags for the run and for the session total", () => {
    const line = resultLine(done, {
      ...base,
      totalCostUsd: 0.5,
      runCostUsd: 0.25,
      runCostIncomplete: true,
      totalCostIncomplete: true,
    });
    expect(line).toMatchObject({
      total_cost_usd: 0.5,
      total_cost_is_incomplete: true,
      cost_is_incomplete: true,
    });
    expect(line).not.toHaveProperty("cost_is_unknown");
  });

  it("an unknown total (no price) is flagged, not only the run", () => {
    const line = resultLine(done, {
      ...base,
      totalCostUsd: 0,
      totalCostUnknown: true,
      runCostUsd: undefined,
    });
    expect(line).toMatchObject({
      total_cost_usd: 0,
      total_cost_is_unknown: true,
      cost_is_unknown: true,
    });
  });

  it("an exact cost has no flags", () => {
    const line = resultLine(done, { ...base, totalCostUsd: 0.5, runCostUsd: 0.25 });
    expect(Object.keys(line).filter((k) => k.includes("cost_is"))).toEqual([]);
  });
});
