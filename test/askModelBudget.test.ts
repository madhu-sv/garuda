import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { FakeModelClient, reply, text } from "../src/model/fake.js";
import { totalTokens } from "../src/model/pricing.js";
import type { Usage } from "../src/model/types.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import { rebuildState } from "../src/session/resume.js";
import { FileSessionStore } from "../src/session/store.js";

/** The job review (askModel) under the session's token budget (Codex review of 1370184). */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-askmodel-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let count = 0;
const usage = (inputTokens: number, outputTokens = 10): Usage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

async function runtime(model: FakeModelClient, tokenBudget: number) {
  const root = join(base, `p${count++}`);
  mkdirSync(root, { recursive: true });
  const store = new FileSessionStore(root);
  const r = await Runtime.create({
    root,
    modelId: "fake",
    model: async () => model,
    approver: new AutoApprover("once"),
    store,
    settings: parseSettings({ executor: "host" }),
    policy: { limits: { tokenBudget } },
    mcp: false,
    hooks: false,
    profiles: [],
  });
  return { r, store };
}
const signal = () => new AbortController().signal;

describe("askModel (the job review) and the token budget", () => {
  it("a budget with no room: no request, a clear error", async () => {
    const model = new FakeModelClient([reply([text("VERDICT: ready")])]);
    const { r } = await runtime(model, 1);
    await expect(r.askModel("review", "the diff", signal())).rejects.toThrow(
      /token budget has no room for the review/,
    );
    expect(model.requests).toHaveLength(0);
    await r.close();
  });

  it("with room: the request reserves first, and its usage goes into the session and its journal", async () => {
    const model = new FakeModelClient([
      reply([text("hi")], undefined, usage(100)),
      reply([text("VERDICT: ready")], undefined, usage(500, 40)),
    ]);
    const { r, store } = await runtime(model, 1_000_000);
    await r.runTurn("hi", signal());
    const before = totalTokens(r.session?.usage ?? usage(0, 0));
    const answer = await r.askModel("review", "the diff", signal());
    expect(answer.text).toBe("VERDICT: ready");
    expect(totalTokens(r.session?.usage ?? usage(0, 0))).toBe(before + 540);
    const id = r.session?.id as string;
    await r.close();
    expect(totalTokens(rebuildState(await store.read(id)).usage)).toBe(before + 540);
  });

  // Review of 3a9f51b (P2): an estimate (no reported usage) was priced as if it were exact.
  it("an estimate has no exact cost: 0 as a minimum, and the session cost is incomplete", async () => {
    const model = new FakeModelClient([
      reply([text("hi")], undefined, usage(100)),
      { ...reply([text("VERDICT: ready")], undefined, usage(500_000, 40)), usageReported: false },
    ]);
    const { r } = await runtime(model, 10_000_000);
    await r.runTurn("hi", signal());
    Object.defineProperty(r, "price", {
      get: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }),
    });
    const answer = await r.askModel("review", "the diff", signal());
    expect(answer.costUsd).toBe(0);
    expect(r.session?.costIncomplete).toBe(true);
    await r.close();
  });
});
