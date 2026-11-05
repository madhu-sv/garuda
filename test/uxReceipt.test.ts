import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import {
  hasReceipt,
  isTestCommand,
  parseTestCount,
  type Receipt,
  ReceiptCollector,
  shortCommand,
} from "../src/app/receipt.js";
import { Runtime } from "../src/app/runtime.js";
import { sessionMarkdown } from "../src/cli/export.js";
import { receiptJson } from "../src/cli/jsonOutput.js";
import { cells, RECEIPT_MAX_WIDTH, receiptText, screenReaderMode } from "../src/cli/receiptView.js";
import { PlainRenderer } from "../src/cli/renderer.js";
import { chatStopMessage, stopMessage } from "../src/cli/report.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { ApprovalChoice, Approver } from "../src/permissions/types.js";
import type { SessionRecord } from "../src/session/records.js";
import { rebuildState } from "../src/session/resume.js";
import { FileSessionStore } from "../src/session/store.js";

/** UX U1, U3 (docs/lld/ux.md): the turn's receipt and the chat's stop messages. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-receipt-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let count = 0;
function folder(name: string): string {
  const dir = join(base, `${name}-${++count}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const signal = () => new AbortController().signal;

type Over = { [K in keyof Receipt]?: Receipt[K] | undefined };
const receipt = (over: Over = {}): Receipt => {
  const r: Record<string, unknown> = { ...defaults(), ...over };
  for (const key of Object.keys(r)) if (r[key] === undefined) delete r[key];
  return r as unknown as Receipt;
};
const defaults = (): Receipt => ({
  turn: 4,
  stopReason: "done",
  steps: 7,
  durationMs: 38_000,
  costUsd: 0.0041,
  files: [
    { path: "src/cart.ts", added: 12, removed: 4 },
    { path: "src/price.ts", added: 3, removed: 1 },
    { path: "test/cart.test.ts", added: 18, removed: 0 },
  ],
  tests: { command: "pnpm test", passed: true, total: 124, failed: 0, previousTotal: 121 },
  commands: { sandboxed: 6, outside: 0, blockedHosts: [] },
  contextPercent: 34,
  sessionCostUsd: 0.0172,
  keptChanges: 4,
});

describe("test commands and counts (decision D2)", () => {
  it("knows the project's test command and the common runners, and not a build", () => {
    expect(isTestCommand("pnpm test", "pnpm test")).toBe(true);
    expect(isTestCommand("make check", "make check")).toBe(true);
    for (const c of [
      "npx vitest run",
      "npm test",
      "pnpm run test -- src",
      "python -m pytest -q",
      "mvn -q test",
      "./gradlew test",
      "go test ./...",
      "node --test",
      "cargo test",
    ]) {
      expect(isTestCommand(c, undefined), c).toBe(true);
    }
    for (const c of ["ls", "mvn -q compile", "pnpm build", "cat test/a.test.ts", "git status"]) {
      expect(isTestCommand(c, undefined), c).toBe(false);
    }
  });

  it("reads the summary line of each known runner; an unknown output gives no count", () => {
    expect(
      parseTestCount(" Test Files  3 passed (3)\n      Tests  2 failed | 122 passed (124)"),
    ).toEqual({
      total: 124,
      failed: 2,
    });
    expect(
      parseTestCount("      Tests  1189 passed | 1 expected fail | 55 skipped (1245)"),
    ).toEqual({
      total: 1245,
      failed: 0,
    });
    expect(parseTestCount("Tests:       2 failed, 122 passed, 124 total")).toEqual({
      total: 124,
      failed: 2,
    });
    expect(parseTestCount("Tests:       5 passed, 5 total")).toEqual({ total: 5, failed: 0 });
    expect(parseTestCount("# tests 12\n# pass 11\n# fail 1")).toEqual({ total: 12, failed: 1 });
    expect(parseTestCount("ℹ tests 3\nℹ pass 3\nℹ fail 0")).toEqual({ total: 3, failed: 0 });
    expect(parseTestCount("===== 2 failed, 122 passed in 1.23s =====")).toEqual({
      total: 124,
      failed: 2,
    });
    expect(parseTestCount("============ 7 passed in 0.12s ============")).toEqual({
      total: 7,
      failed: 0,
    });
    expect(
      parseTestCount(
        "Tests run: 3, Failures: 0, Errors: 0, Skipped: 0\nResults:\nTests run: 9, Failures: 1, Errors: 1, Skipped: 0",
      ),
    ).toEqual({ total: 9, failed: 2 });
    expect(parseTestCount("=== RUN   TestA\n--- PASS: TestA\n--- FAIL: TestB")).toEqual({
      total: 2,
      failed: 1,
    });
    expect(parseTestCount("All good, 3 things done.")).toBeUndefined();
  });

  it("cuts a long command to one short line", () => {
    expect(shortCommand("pnpm test\nmore")).toBe("pnpm test");
    expect(cells(shortCommand("x".repeat(80)))).toBe(40);
  });
});

describe("the collector", () => {
  it("counts commands by where they ran, the blocked hosts and the last test run", () => {
    const c = new ReceiptCollector("pnpm test");
    const call = (id: string, command: string) => ({
      type: "tool_use" as const,
      id,
      name: "bash",
      input: { command },
    });
    c.onEvent({ type: "tool_call", call: call("1", "pnpm install") });
    c.onEvent({
      type: "tool_result",
      call: call("1", "pnpm install"),
      outcome: {
        content: "Exit code: 1",
        isError: false,
        command: {
          exitCode: 1,
          timedOut: false,
          sandboxed: true,
          blockedHosts: ["registry.npmjs.org"],
        },
      },
    });
    c.onEvent({ type: "tool_call", call: call("2", "pnpm test") });
    c.onEvent({
      type: "tool_result",
      call: call("2", "pnpm test"),
      outcome: {
        content: "Exit code: 0\n<stdout>\n      Tests  5 passed (5)\n</stdout>",
        isError: false,
        command: { exitCode: 0, timedOut: false, sandboxed: false, blockedHosts: [] },
      },
    });
    // A tool result with no command facts (read_file) changes nothing.
    c.onEvent({
      type: "tool_result",
      call: { type: "tool_use", id: "3", name: "read_file", input: { path: "a" } },
      outcome: { content: "x", isError: false },
    });
    expect([c.sandboxed, c.outside, [...c.blockedHosts]]).toEqual([1, 1, ["registry.npmjs.org"]]);
    expect(c.tests).toEqual({ command: "pnpm test", passed: true, total: 5, failed: 0 });
  });

  it("a test command that timed out did not pass", () => {
    const c = new ReceiptCollector(undefined);
    c.add(
      "npx vitest run",
      { exitCode: null, timedOut: true, sandboxed: true, blockedHosts: [] },
      "",
    );
    expect(c.tests).toEqual({ command: "npx vitest run", passed: false, timedOut: true });
  });
});

describe("the view", () => {
  it("draws a box of the same width on every line, at 80 columns", () => {
    const lines = receiptText(receipt(), { columns: 80 }).split("\n");
    expect(lines[0]).toMatch(/^╭─ Turn 4 · done · 7 steps · 38 s ─+ \$0\.0041 ─╮$/);
    expect(lines[1]).toContain("Files    src/cart.ts +12 −4 · src/price.ts +3 −1 · 1 more");
    expect(lines[2]).toContain("Tests    pnpm test ✓ passed (124 tests, was 121)");
    expect(lines[3]).toContain("Sandbox  ⛨ 6 commands in the sandbox · 0 outside");
    expect(lines[4]).toContain("Undo     /undo puts back 3 files");
    expect(lines[5]).toMatch(
      /^╰─ context 34% · session \$0\.02 · 4 kept changes · \$0\.0043 each ─+╯$/,
    );
    for (const line of lines) expect(cells(line)).toBe(RECEIPT_MAX_WIDTH);
    for (const line of receiptText(receipt(), { columns: 64 }).split("\n")) {
      expect(cells(line)).toBe(64);
    }
  });

  it("under 60 columns, with no terminal, or for a screen reader: plain lines", () => {
    const narrow = receiptText(receipt(), { columns: 50 });
    expect(narrow).not.toMatch(/[╭│╰]/);
    expect(narrow.split("\n")).toEqual([
      "Turn 4 · done · 7 steps · 38 s · $0.0041",
      "Files: src/cart.ts +12 −4 · src/price.ts +3 −1 · test/cart.test.ts +18 −0",
      "Tests: pnpm test ✓ passed (124 tests, was 121)",
      "Sandbox: ⛨ 6 commands in the sandbox · 0 outside",
      "Undo: /undo puts back 3 files",
      "context 34% · session $0.02 · 4 kept changes · $0.0043 each",
    ]);
    expect(receiptText(receipt())).toBe(narrow);
    expect(receiptText(receipt(), { columns: 120, screenReader: true })).toBe(narrow);
    expect(screenReaderMode({ GARUDA_SCREEN_READER: "1" })).toBe(true);
    expect(screenReaderMode({})).toBe(false);
  });

  it("names a failure, a blocked host and commands outside the sandbox in words, not only in color", () => {
    const text = receiptText(
      receipt({
        tests: { command: "pnpm test", passed: false, total: 126, failed: 2 },
        commands: { sandboxed: 2, outside: 1, blockedHosts: ["registry.npmjs.org"] },
      }),
    );
    expect(text).toContain("Tests: pnpm test ✗ failed (2 of 126)");
    expect(text).toContain("Sandbox: ⛨ 2 commands in the sandbox · 1 outside");
    expect(text).toContain("Network: blocked registry.npmjs.org");
    const painted = receiptText(receipt({ tests: { command: "t", passed: false } }), {
      paint: (style, t) => `<${style}>${t}</${style}>`,
    });
    expect(painted).toContain("<red>✗ failed</red>");
  });

  it("says when undo is off, and when no file changed", () => {
    expect(receiptText(receipt({ files: undefined }))).toContain(
      "Files: undo is off: no file list",
    );
    const none = receiptText(receipt({ files: [], keptChanges: 0 }));
    expect(none).toContain("Files: no file changed");
    expect(none).not.toContain("Undo:");
    expect(none).not.toContain("kept change");
  });

  it("a turn that only read has no receipt, also with commands in the sandbox (decision D1)", () => {
    const quiet = receipt({
      files: [],
      tests: undefined,
      commands: { sandboxed: 0, outside: 0, blockedHosts: [] },
    });
    expect(hasReceipt(quiet)).toBe(false);
    // The first live run: `find` in the sandbox gave a receipt that said nothing new.
    expect(hasReceipt({ ...quiet, commands: { ...quiet.commands, sandboxed: 3 } })).toBe(false);
    expect(hasReceipt(receipt())).toBe(true);
    expect(hasReceipt({ ...quiet, files: [{ path: "a", added: 1, removed: 0 }] })).toBe(true);
    expect(hasReceipt({ ...quiet, tests: { command: "pnpm test", passed: true } })).toBe(true);
    expect(
      hasReceipt({ ...quiet, commands: { ...quiet.commands, blockedHosts: ["pypi.org"] } }),
    ).toBe(true);
    expect(
      hasReceipt(receipt({ files: undefined, commands: { ...quiet.commands, outside: 1 } })),
    ).toBe(true);
  });

  it("the plain renderer prints plain lines on a pipe", () => {
    const err = new PassThrough();
    let written = "";
    err.on("data", (d) => {
      written += String(d);
    });
    const renderer = new PlainRenderer({ out: new PassThrough(), err }, false);
    renderer.receipt(receipt());
    expect(written).toContain("Turn 4 · done · 7 steps · 38 s · $0.0041\nFiles: src/cart.ts");
    expect(written).not.toContain("╭");
  });

  it("the JSON result has the receipt with snake_case keys", () => {
    expect(receiptJson(receipt({ files: [{ path: "a.bin" }] }))).toMatchObject({
      turn: 4,
      stop_reason: "done",
      cost_usd: 0.0041,
      files: [{ path: "a.bin", binary: true }],
      tests: { command: "pnpm test", passed: true, total: 124, failed: 0, previous_total: 121 },
      commands: { sandboxed: 6, outside: 0, blocked_hosts: [] },
      context_percent: 34,
      kept_changes: 4,
    });
    expect(receiptJson(receipt({ files: undefined, costUsd: undefined }))).toMatchObject({
      files: null,
      cost_is_unknown: true,
    });
  });
});

describe("stop messages in the chat (UX U3)", () => {
  it("the chat names no flag; -p keeps the flags", () => {
    const limits = { maxSteps: 50, tokenBudget: 20_000_000 };
    expect(chatStopMessage("max_steps", limits)).toBe(
      "■ Stopped at the step limit (50). The task is not finished.",
    );
    expect(chatStopMessage("repeated_calls", limits)).toMatch(/Type a hint as your next message/);
    expect(stopMessage("max_steps", limits)).toMatch(/--resume/);
    expect(chatStopMessage("token_budget", limits)).toBe(stopMessage("token_budget", limits));
    expect(chatStopMessage("done", limits)).toBeUndefined();
  });
});

class Yes implements Approver {
  async ask(): Promise<ApprovalChoice> {
    return "once";
  }
}

describe("the runtime makes the receipt (UX U1)", () => {
  async function runtimeFor(root: string, model: FakeModelClient, resume?: true) {
    return Runtime.create({
      root,
      modelId: "fake",
      model: async () => model,
      approver: new Yes(),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      commands: false,
      profiles: [],
      undo: { home: join(root, "..", `home-${count}`) },
      ...(resume === undefined ? {} : { resume }),
    });
  }

  it("files, tests, commands and kept changes; a record that resume reads back", async () => {
    const root = folder("turns");
    writeFileSync(join(root, "a.txt"), "one\n");
    mkdirSync(join(root, "test"));
    writeFileSync(
      join(root, "test", "a.test.mjs"),
      'import test from "node:test";\ntest("a", () => {});\n',
    );
    const model = new FakeModelClient([
      reply([toolUse("write_file", { path: "b.txt", content: "new\nfile\n" }, "w1")]),
      reply([toolUse("bash", { command: "node --test" }, "b1")]),
      reply([text("Done.")]),
      reply([toolUse("read_file", { path: "a.txt" }, "r1")]),
      reply([text("It says one.")]),
    ]);
    const runtime = await runtimeFor(root, model);
    await runtime.runTurn("Add b.", signal());
    const first = runtime.lastReceipt;
    expect(first).toMatchObject({
      turn: 1,
      stopReason: "done",
      steps: 3,
      files: [{ path: "b.txt", added: 2, removed: 0 }],
      tests: { command: "node --test", passed: true, total: 1, failed: 0 },
      // The host executor: no OS sandbox, so the command ran outside it.
      commands: { sandboxed: 0, outside: 1, blockedHosts: [] },
      keptChanges: 1,
    });
    expect(first === undefined ? false : hasReceipt(first)).toBe(true);

    // A turn that only reads: no file, no command, so no receipt is shown (D1).
    await runtime.runTurn("What is in a?", signal());
    const second = runtime.lastReceipt;
    expect(second).toMatchObject({ turn: 2, files: [], keptChanges: 1 });
    expect(second === undefined ? true : hasReceipt(second)).toBe(false);

    const records = (await new FileSessionStore(root).read(
      runtime.session?.id as string,
    )) as SessionRecord[];
    expect(records.filter((r) => r.type === "receipt")).toHaveLength(2);
    const state = rebuildState(records);
    expect(state.turns).toBe(2);
    expect(state.lastTestTotal).toBe(1);
    expect(state.undo.points.map((p) => p.changedFiles)).toEqual([1, 0]);

    // The export shows the receipt of the first turn, not of the second.
    const markdown = sessionMarkdown(records, runtime.session?.id as string);
    expect(markdown).toContain("> Turn 1 · done · 3 steps");
    expect(markdown).toContain("> Files: b.txt +2 −0");
    expect(markdown).not.toContain("> Turn 2");
    runtime.executor.shutdown();
  });

  it("an undone turn is no longer a kept change", async () => {
    const root = folder("undo");
    const model = new FakeModelClient([
      reply([toolUse("write_file", { path: "b.txt", content: "x\n" }, "w1")]),
      reply([text("Done.")]),
      reply([toolUse("write_file", { path: "c.txt", content: "y\n" }, "w2")]),
      reply([text("Done.")]),
    ]);
    const runtime = await runtimeFor(root, model);
    await runtime.runTurn("Add b.", signal());
    await runtime.undo(signal());
    await runtime.runTurn("Add c.", signal());
    expect(runtime.lastReceipt).toMatchObject({ turn: 2, keptChanges: 1 });
    runtime.executor.shutdown();
  });

  it("with undo off, the receipt has no file list and no kept changes", async () => {
    const root = folder("noundo");
    const model = new FakeModelClient([
      reply([toolUse("write_file", { path: "b.txt", content: "x\n" }, "w1")]),
      reply([text("Done.")]),
    ]);
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: async () => model,
      approver: new Yes(),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      commands: false,
      profiles: [],
    });
    await runtime.runTurn("Add b.", signal());
    expect(runtime.lastReceipt?.files).toBeUndefined();
    expect(runtime.lastReceipt?.keptChanges).toBeUndefined();
    runtime.executor.shutdown();
  });
});
