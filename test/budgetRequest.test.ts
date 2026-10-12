import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fullRequestTokens } from "../src/loop/budget.js";
import { runAgent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text } from "../src/model/fake.js";
import type { ModelRequest, ServerToolSpec } from "../src/model/types.js";
import { resumeSession } from "../src/session/resume.js";
import { addUserMessage, budgetSpent, createSession } from "../src/session/session.js";
import { FileSessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { allowAll, upperTool } from "./helpers.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "garuda-budget-request-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The fake provider uses the same full-request estimate as admission: any overshoot here
// comes from missing request bytes, not from a different provider tokenizer.
const respond = (request: ModelRequest) =>
  reply([text("ok")], undefined, {
    inputTokens: fullRequestTokens(request),
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });

describe("request budget after resume", () => {
  for (const changed of ["instructions", "tools", "server-tools"] as const) {
    for (const cap of [500, 5_000]) {
      it(`${changed}: ${cap === 500 ? "refuses before calling" : "runs when the full request fits"}`, async () => {
        const id = `${changed}-${cap}`;
        const store = new FileSessionStore(root);
        const journal = store.open(id);
        const start = {
          root,
          version: "test",
          model: "first",
          executor: "none",
          isolation: "none",
          limits: { maxSteps: 3, tokenBudget: cap, contextWindow: 100_000 },
        };
        journal.write({ type: "start", sessionId: id, ...start });
        const session = createSession(root, id, journal);
        addUserMessage(session, "go");
        const first = new FakeModelClient([respond]);
        const deps = { permissions: allowAll(root), maxTokens: 10, tokenBudget: cap };
        await runAgent(session, {
          ...deps,
          model: first,
          tools: new ToolRegistry(),
          system: "s",
        });
        expect(first.requests).toHaveLength(1);

        // Resume the actual on-disk journal, with a new model and its current request settings.
        const resumed = await resumeSession({
          store,
          root,
          sessionId: id,
          start: { ...start, model: "second" },
        });
        expect(resumed.contextTokens).toBe(session.contextTokens);
        const before = budgetSpent(resumed);
        addUserMessage(resumed, "again");
        const system = changed === "instructions" ? "s".repeat(8_000) : "s";
        const tools = new ToolRegistry(
          changed === "tools" ? [{ ...upperTool(), description: "d".repeat(8_000) }] : [],
        );
        const serverTools: ServerToolSpec[] =
          changed === "server-tools"
            ? [
                {
                  type: "web_search",
                  maxUses: 1,
                  allowedDomains: Array.from({ length: 400 }, (_, i) => `site${i}.example.com`),
                },
              ]
            : [];
        const next = new FakeModelClient([respond], { serverTools: ["web_search"] });
        const result = await runAgent(resumed, {
          ...deps,
          model: next,
          tools,
          system,
          ...(serverTools.length === 0 ? {} : { serverTools }),
        });
        if (cap === 500) {
          expect(result.stopReason).toBe("token_budget");
          expect(result.steps).toBe(0);
          expect(next.requests).toHaveLength(0);
          expect(budgetSpent(resumed)).toBe(before);
        } else {
          expect(result.stopReason).toBe("done");
          expect(next.requests).toHaveLength(1);
          expect(budgetSpent(resumed)).toBeGreaterThan(before);
          expect(budgetSpent(resumed)).toBeLessThanOrEqual(cap);
        }
      });
    }
  }

  it("keeps a higher measured context allowance even when the character estimate is smaller", async () => {
    const session = createSession(root);
    addUserMessage(session, "go");
    const first = new FakeModelClient([
      reply([text("ok")], undefined, {
        inputTokens: 300,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ]);
    const deps = {
      tools: new ToolRegistry(),
      system: "s",
      permissions: allowAll(root),
      maxTokens: 10,
      tokenBudget: 500,
    };
    await runAgent(session, { ...deps, model: first });
    addUserMessage(session, "again");
    const next = new FakeModelClient([respond]);
    const result = await runAgent(session, { ...deps, model: next });
    expect(result.stopReason).toBe("token_budget");
    expect(next.requests).toHaveLength(0);
    expect(budgetSpent(session)).toBe(301);
  });
});
