import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Receipt } from "../src/app/receipt.js";
import { Runtime } from "../src/app/runtime.js";
import { adviceHtml, adviceText, estimateUsd } from "../src/cli/advise.js";
import { runCommand } from "../src/cli/chat/commands.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { callChange, escapeHtml, sessionHtml } from "../src/cli/exportHtml.js";
import { compareReports, type LoadedReport } from "../src/evals/compare.js";
import type { EvalResult } from "../src/evals/types.js";
import { FakeModelClient, reply, text } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { SessionRecord } from "../src/session/records.js";
import { FileSessionStore } from "../src/session/store.js";

/** UX U11 and U8 (docs/lld/ux.md): the HTML export and `garuda advise`. */

const t = "2026-11-06T10:00:00.000Z";
const HOSTILE = '<script>alert("x")</script><img src=x onerror=alert(1)>';

function records(): SessionRecord[] {
  const receipt: Receipt = {
    turn: 1,
    stopReason: "done",
    steps: 2,
    durationMs: 1000,
    costUsd: 0.001,
    files: [{ path: `src/${HOSTILE}.ts`, added: 1, removed: 0 }],
    commands: { sandboxed: 1, outside: 0, blockedHosts: [] },
    contextPercent: 3,
  };
  return [
    {
      t,
      type: "start",
      sessionId: "s1",
      root: "/r",
      model: "m",
      executor: "host",
      isolation: "none",
      limits: { maxSteps: 50, tokenBudget: 1, contextWindow: 1 },
    } as unknown as SessionRecord,
    {
      t,
      type: "user",
      message: { role: "user", content: [{ type: "text", text: `fix it ${HOSTILE}` }] },
    },
    {
      t,
      type: "assistant",
      costUsd: 0,
      response: {
        content: [
          { type: "text", text: `I will edit ${HOSTILE}` },
          {
            type: "tool_use",
            id: "e1",
            name: "edit_file",
            input: { path: "a.ts", old_string: "a = 1", new_string: `a = 2 ${HOSTILE}` },
          },
          { type: "tool_use", id: "b1", name: "bash", input: { command: "pnpm test" } },
        ],
      },
    } as unknown as SessionRecord,
    {
      t,
      type: "tool_results",
      calls: [],
      message: {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "e1", content: "Edited a.ts", isError: false },
          {
            type: "tool_result",
            toolUseId: "b1",
            content: `Exit code: 1\n${HOSTILE} https://evil.example/`,
            isError: true,
          },
        ],
      },
    } as unknown as SessionRecord,
    { t, type: "receipt", receipt },
  ];
}

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-export-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("/export --html", () => {
  it("writes garuda-<id>.html in the folder; /export alone still writes Markdown", async () => {
    const runtime = await Runtime.create({
      root: base,
      modelId: "fake",
      model: async () => new FakeModelClient([reply([text("Hello.")])]),
      approver: new AutoApprover("once"),
      store: new FileSessionStore(base),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      commands: false,
      profiles: [],
    });
    await runtime.runTurn("Say hello.", new AbortController().signal);
    const store = new ChatStore({ model: "m", sandbox: "s" }, { paint: noColor });
    const context = { runtime, renderer: store, sessionPath: (id: string) => id };
    await runCommand("/export --html", context);
    await runCommand("/export", context);
    const id = runtime.session?.id as string;
    expect(readFileSync(join(base, `garuda-${id}.html`), "utf8")).toMatch(/^<!doctype html>/);
    expect(existsSync(join(base, `garuda-${id}.md`))).toBe(true);
    runtime.executor.shutdown();
  });

  const html = sessionHtml(records(), "s1");

  it("escapes every text: a prompt, an answer, a tool output and a file name run nothing", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    // No real tag has a link or a source (escaped text may still read "src=", which is harmless).
    expect(html).not.toMatch(/<[a-z][^<>]*\s(?:href|src)=/i);
    // The page's own policy forbids scripts and outside resources.
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
  });

  it("has the request, the answer, each call with its output or change, and the receipt", () => {
    expect(html).toContain('<div class="you">fix it ');
    expect(html).toContain('<div class="answer">I will edit ');
    expect(html).toMatch(/<details><summary>● edit_file a\.ts → /);
    expect(html).toContain('<span class="del">-a = 1</span>');
    expect(html).toMatch(/<span class="add">\+a = 2 &lt;script&gt;/);
    expect(html).toMatch(/<details class="failed"><summary>● bash pnpm test → failed: /);
    expect(html).toContain('<pre class="receipt">Turn 1 · done · 2 steps');
  });

  it("shows a write_file as added lines, and other calls as their output", () => {
    expect(
      callChange({ type: "tool_use", id: "w", name: "write_file", input: { content: "x\ny" } }),
    ).toBe("+x\n+y");
    expect(
      callChange({ type: "tool_use", id: "r", name: "read_file", input: { path: "a" } }),
    ).toBeUndefined();
    expect(escapeHtml(`a&b<'">`)).toBe("a&amp;b&lt;&#39;&quot;&gt;");
  });
});

const run = (id: string, passed: boolean, costUsd: number, attempt: number): EvalResult => ({
  id,
  title: id,
  passed,
  stopReason: "done",
  steps: 5,
  tokens: 1000,
  costUsd,
  durationMs: 1000,
  attempt,
});
/** A report: each of 12 tasks passes `passes` of 2 runs, at `cost` a run (a little spread). */
function report(path: string, passes: number, cost: number): LoadedReport {
  const results = Array.from({ length: 12 }, (_, i) =>
    [1, 2].map((k) => run(`t${i}`, k <= passes, cost * (1 + (i % 3) * 0.05), k)),
  ).flat();
  return {
    path,
    schema: 2,
    model: path,
    seed: 1,
    tasks: Object.fromEntries(results.map((r) => [r.id, `h-${r.id}`])),
    results,
  };
}
const compare = (a: LoadedReport, b: LoadedReport) => {
  const r = compareReports(a, b, { seed: 1 });
  if ("problems" in r) throw new Error(r.problems.join("; "));
  return r.comparison;
};

describe("garuda advise", () => {
  it("on a tie in passes, the cheaper model wins", () => {
    const c = compare(report("haiku", 2, 0.004), report("sonnet", 2, 0.04));
    expect(adviceText("haiku", "sonnet", c, 12)).toBe(
      "Advice: haiku for this repo. It passes as often, and sonnet costs 10.0 times as much per accepted change.",
    );
    const d = compare(report("sonnet", 2, 0.04), report("haiku", 2, 0.004));
    expect(adviceText("sonnet", "haiku", d, 12)).toMatch(
      /^Advice: haiku for this repo\. It passes as often, and sonnet costs 10\.0 times/,
    );
  });

  it("a model that passes clearly more wins, whatever it costs", () => {
    const c = compare(report("haiku", 0, 0.004), report("sonnet", 2, 0.04));
    expect(adviceText("haiku", "sonnet", c, 12)).toBe(
      "Advice: sonnet for this repo. It passes more often.",
    );
  });

  it("when neither model passes a task, it gives no advice and points at the check", () => {
    const c = compare(report("haiku", 0, 0.004), report("sonnet", 0, 0.04));
    expect(adviceText("haiku", "sonnet", c, 12)).toMatch(
      /^Advice: none\. Neither model passed a task, so the check itself may fail/,
    );
  });

  it("with fewer than 10 tasks it says the advice is a rough guide", () => {
    const c = compare(report("haiku", 2, 0.004), report("sonnet", 2, 0.04));
    expect(adviceText("haiku", "sonnet", c, 6)).toMatch(/With 6 tasks, this is a rough guide\.$/);
  });

  it("estimates the cost from the price list, and the page escapes its text", () => {
    expect(estimateUsd({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, 10)).toBeCloseTo(
      0.675,
    );
    expect(estimateUsd(undefined, 10)).toBeUndefined();
    const page = adviceHtml(`<b>x</b>`, "Advice: <i>y</i>");
    expect(page).not.toContain("<b>");
    expect(page).toContain("&lt;i&gt;y&lt;/i&gt;");
  });
});
