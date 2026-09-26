import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { SwitchApprover } from "../src/cli/approver.js";
import { DIFF_LINES, runCommand } from "../src/cli/chat/commands.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { Notifier, notificationBytes, pickChannel } from "../src/cli/notify.js";
import { runTurnInTerminal } from "../src/cli/turn.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { ApprovalRequest } from "../src/permissions/types.js";
import { FileSessionStore } from "../src/session/store.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-notifydiff-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const signal = () => new AbortController().signal;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the colors go.
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const DONE = {
  kind: "done" as const,
  result: {
    stopReason: "done" as const,
    steps: 1,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    apiMs: 0,
  },
};

describe("notifications (0.6)", () => {
  it("auto picks OSC 9 in iTerm2, Ghostty and WezTerm, the bell elsewhere and in tmux", () => {
    expect(pickChannel(undefined, { TERM_PROGRAM: "iTerm.app" })).toBe("osc9");
    expect(pickChannel("auto", { TERM_PROGRAM: "ghostty" })).toBe("osc9");
    expect(pickChannel(undefined, { TERM_PROGRAM: "Apple_Terminal" })).toBe("bell");
    expect(pickChannel(undefined, { TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/t,1,0" })).toBe("bell");
    expect(pickChannel("off", { TERM_PROGRAM: "iTerm.app" })).toBe("off");
    // GARUDA_NOTIFY wins over the setting.
    expect(pickChannel("off", { GARUDA_NOTIFY: "bell" })).toBe("bell");
    expect(pickChannel("osc9", { GARUDA_NOTIFY: "off" })).toBe("off");
  });

  it("writes an OSC 9 text without control characters, or a bell", () => {
    expect(notificationBytes("osc9", "done\x1b]9;evil\x07 now")).toBe(
      "\x1b]9;done ]9;evil now\x07",
    );
    expect(notificationBytes("bell", "anything")).toBe("\x07");
    expect(notificationBytes("off", "anything")).toBe("");
    expect(notificationBytes("osc9", "x".repeat(300))).toHaveLength(4 + 120 + 1);
  });

  it("notifies an approval only during a turn, and only long turns that were not stopped", () => {
    const sent: string[] = [];
    const notifier = new Notifier("osc9", (b) => sent.push(b), 10);
    const request: ApprovalRequest = {
      tool: "bash",
      target: { kind: "command", command: "npm test\nmore" },
      preview: "npm test",
      isolation: "none",
    };
    notifier.approval(request); // after /undo: the user is here
    notifier.turnStarted();
    notifier.approval(request);
    notifier.turnEnded(DONE, 3_000); // short
    notifier.turnStarted();
    notifier.turnEnded({ kind: "interrupted" }, 60_000);
    notifier.turnStarted();
    notifier.turnEnded(DONE, 42_000);
    notifier.turnStarted();
    notifier.turnEnded({ kind: "error", message: "x" }, 75_000);
    notifier.turnStarted();
    notifier.turnEnded({ ...DONE, result: { ...DONE.result, stopReason: "max_steps" } }, 12_000);
    expect(sent).toEqual([
      "\x1b]9;Garuda needs your approval: bash: npm test\x07",
      "\x1b]9;Garuda: the task is done (42 s).\x07",
      "\x1b]9;Garuda: the task failed after 1 min 15 s.\x07",
      "\x1b]9;Garuda: the task stopped (max_steps) after 12 s.\x07",
    ]);
  });

  it("the chat wiring: the approver and the turn runner tell the notifier", async () => {
    const root = join(base, `p${n++}`);
    mkdirSync(root);
    const sent: string[] = [];
    const notifier = new Notifier("bell", (b) => sent.push(b), 0);
    const approver = new SwitchApprover(new AutoApprover("once"));
    approver.onAsk = (r) => notifier.approval(r);
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: async () =>
        new FakeModelClient([
          reply([toolUse("write_file", { path: "a.txt", content: "a\n" }, "w1")]),
          reply([text("Done.")]),
        ]),
      approver,
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host", notifications: { channel: "bell" } }),
      mcp: false,
      hooks: false,
      profiles: [],
    });
    expect(runtime.notificationSettings).toEqual({ channel: "bell" });
    const silent = { event: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const outcome = await runTurnInTerminal(
      runtime,
      { onInterrupt: () => {} },
      silent,
      "write a",
      () => {
        throw new Error("exit");
      },
      notifier,
    );
    expect(outcome.kind).toBe("done");
    // One bell for the write approval, one for the end (afterSeconds 0).
    expect(sent).toEqual(["\x07", "\x07"]);
  });

  it("the setting is checked", () => {
    expect(() => parseSettings({ notifications: { channel: "loud" } })).toThrow(/notifications/);
    expect(parseSettings({ notifications: { afterSeconds: 30 } }).notifications).toEqual({
      afterSeconds: 30,
    });
  });
});

describe("/diff (0.6)", () => {
  async function setup() {
    const root = join(base, `p${n++}`);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/math.js"), "export const add = (a, b) => a - b;\n");
    writeFileSync(join(root, "old.txt"), "old\n");
    const model = new FakeModelClient([
      reply([
        toolUse(
          "edit_file",
          { path: "src/math.js", old_string: "a - b", new_string: "a + b" },
          "e0",
        ),
      ]),
      reply([text("Fixed.")]),
      reply([toolUse("write_file", { path: "src/new.js", content: "one\ntwo\n" }, "w1")]),
      reply([text("Added.")]),
    ]);
    // "@src/math.js" in the first prompt counts as a read, so the edit works at once.
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: async () => model,
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      profiles: [],
      undo: { home: join(root, "..", `home${n}`) },
    });
    const store = new ChatStore({ model: "m", sandbox: "none" }, { paint: noColor });
    const shown: string[] = [];
    const run = (line: string) =>
      runCommand(line, {
        runtime,
        renderer: store,
        sessionPath: (id) => id,
        output: (t, full) => {
          shown.push(plain(t));
          if (full !== undefined) store.keepOutput(full.title, full.text);
        },
      });
    const said = () => store.getState().items.map((i) => i.text);
    return { root, runtime, run, said, shown, store };
  }

  it("shows the session's changes, the last turn's, one path's, and your own edits", async () => {
    const { root, runtime, run, said, shown } = await setup();
    await run("/diff");
    expect(said().at(-1)).toBe("No turn has run in this session yet.");

    await runtime.runTurn("fix @src/math.js", signal());
    await runtime.runTurn("add a file", signal());
    unlinkSync(join(root, "old.txt")); // the user's own change

    await run("/diff");
    const all = shown.at(-1) as string;
    expect(all).toMatch(
      /^Changes since the first turn of this session \(3 files, \+3 −2\)\. Changes you made yourself count too\.\n/,
    );
    expect(all).toMatch(/ {2}D old\.txt +−1\n {2}M src\/math\.js +\+1 −1\n {2}A src\/new\.js +\+2/);
    expect(all).toContain("-export const add = (a, b) => a - b;");
    expect(all).toContain("+export const add = (a, b) => a + b;");

    await run("/diff last");
    expect(shown.at(-1)).toMatch(/^Changes since the start of the last turn \(2 files, \+2 −1\)/);
    expect(shown.at(-1)).not.toContain("math.js");

    await run("/diff src/math.js");
    expect(shown.at(-1)).toMatch(
      /^Changes in src\/math\.js since the first turn .*\(1 file, \+1 −1\)/,
    );
    await run("/diff last src/math.js");
    expect(said().at(-1)).toBe("No file changed in src/math.js since the start of the last turn.");
    await run("/diff ../x");
    expect(said().at(-1)).toBe("../x is outside the working folder.");
  });

  it("cuts a long diff; Ctrl-O shows all", async () => {
    const { runtime, run, shown, store } = await setup();
    await runtime.runTurn("fix @src/math.js", signal());
    const long = Array.from({ length: DIFF_LINES + 50 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(join(runtime.root, "src/long.txt"), `${long}\n`);
    await run("/diff");
    const out = shown.at(-1) as string;
    expect(out).toMatch(/… \d+ more lines\. Ctrl-O shows all; \/diff <path> shows one file\.$/);
    store.showLastOutput();
    expect(plain(JSON.stringify(store.getState().items.at(-1)))).toContain(
      `line ${DIFF_LINES + 49}`,
    );
  });

  it("without undo snapshots it says why", async () => {
    const root = join(base, `p${n++}`);
    mkdirSync(root);
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: async () => new FakeModelClient([]),
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      profiles: [],
    });
    expect(await runtime.diff("session", undefined, signal())).toEqual({
      problem:
        "/diff needs the undo snapshots, and they are off for this session (see /help or the undo setting).",
    });
  });
});
