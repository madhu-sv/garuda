import { describe, expect, it } from "vitest";
import { usageLine } from "../src/cli/report.js";
import type { Usage } from "../src/model/types.js";
import { summariseSession } from "../src/session/list.js";
import {
  addChildDebit,
  addChildReport,
  createSession,
  isCostIncomplete,
} from "../src/session/session.js";
import { MemoryJournal } from "../src/session/store.js";

/**
 * Codex review of 1370184 (P3): a child's spend with no report (a cancelled subagent) is in the
 * budget, but its USD cost is not. The cost is then a minimum, and the budget line must show.
 */

const usage = (inputTokens: number): Usage => ({
  inputTokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

describe("pending child debits", () => {
  it("make the cost a minimum and show the budget line", () => {
    const session = createSession("/tmp/p", "s1");
    session.costUsd = 0.5;
    addChildDebit(session, "child-1", 700);
    expect(isCostIncomplete(session)).toBe(true);
    const line = usageLine(
      { stopReason: "done", steps: 1, usage: usage(10), apiMs: 0 },
      session,
      0.25,
      200_000,
    );
    expect(line).toContain("session 0 tokens, ≥ $0.50 (incomplete)");
    expect(line).toContain("budget 700 tokens (700 from subagents with no report)");
  });

  it("a full report settles the debit: the cost is complete again", () => {
    const session = createSession("/tmp/p", "s2");
    addChildDebit(session, "child-1", 700);
    addChildReport(session, {
      sessionId: "child-1",
      model: "fake",
      steps: 1,
      stopReason: "done",
      usage: usage(700),
      costUsd: 0.01,
    });
    expect(isCostIncomplete(session)).toBe(false);
  });

  it("/sessions marks a session with a pending debit incomplete", () => {
    const journal = new MemoryJournal();
    const session = createSession("/tmp/p", "s3", journal);
    addChildDebit(session, "child-1", 700);
    expect(summariseSession("s3", new Date(), journal.records).costIncomplete).toBe(true);
  });
});
