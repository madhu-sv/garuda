import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { runCommand } from "../src/cli/chat/commands.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ago, rewindList } from "../src/cli/chat/rewind.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { sessionMarkdown } from "../src/cli/export.js";
import { BUILTIN_COMMANDS } from "../src/commands/builtins.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../src/permissions/types.js";
import { rebuildState } from "../src/session/resume.js";
import { FileSessionStore } from "../src/session/store.js";
import type { UndoPoint } from "../src/session/undo.js";

/** UX U6 (docs/lld/ux.md): /rewind and /rewind fork. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-rewind-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let count = 0;
function folder(name: string): string {
  const dir = join(base, `${name}-${++count}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const signal = () => new AbortController().signal;

class Recorder implements Approver {
  readonly requests: ApprovalRequest[] = [];
  constructor(private readonly rewindAnswer: ApprovalChoice = "once") {}
  async ask(request: ApprovalRequest): Promise<ApprovalChoice> {
    this.requests.push(request);
    return request.tool === "undo" || request.tool === "fork" ? this.rewindAnswer : "once";
  }
}

/** Three turns: each writes one file (a, b, c). */
async function threeTurns(answer: ApprovalChoice = "once") {
  const root = folder("p");
  const write = (path: string, id: string) => [
    reply([toolUse("write_file", { path, content: `${path}\n` }, id)]),
    reply([text("Done.")]),
  ];
  const model = new FakeModelClient([
    ...write("a.txt", "w1"),
    ...write("b.txt", "w2"),
    ...write("c.txt", "w3"),
  ]);
  const approver = new Recorder(answer);
  const runtime = await Runtime.create({
    root,
    modelId: "fake",
    model: async () => model,
    approver,
    store: new FileSessionStore(root),
    settings: parseSettings({ executor: "host" }),
    mcp: false,
    hooks: false,
    commands: false,
    profiles: [],
    undo: { home: join(root, "..", `home-${count}`) },
  });
  for (const p of ["Add a.", "Add b.", "Add c."]) await runtime.runTurn(p, signal());
  return { root, runtime, approver };
}
const has = (root: string, name: string) => existsSync(join(root, name));

describe("/rewind", () => {
  it("goes back to the start of turn 2 in one question; /redo brings the turns back in order", async () => {
    const { root, runtime, approver } = await threeTurns();
    const messagesAtTurn2 = runtime.rewindPoints[1]?.messages;
    const said = await runtime.rewind(2, signal());
    expect(said).toBe(
      'Rewound to the start of turn 2 ("Add b."): 2 turns taken back, 2 files changed. /redo brings them back one at a time.',
    );
    const asked = approver.requests.filter((r) => r.tool === "undo");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.title).toBe("Rewind to turn 2?");
    expect(asked[0]?.preview).toContain("- b.txt");
    expect(asked[0]?.preview).toContain("- c.txt");
    expect([has(root, "a.txt"), has(root, "b.txt"), has(root, "c.txt")]).toEqual([
      true,
      false,
      false,
    ]);
    expect(runtime.session?.messages).toHaveLength(messagesAtTurn2 as number);
    expect(runtime.rewindPoints).toHaveLength(1);

    // The negative control of the order: each /redo brings back the next turn, b before c.
    await runtime.redo(signal());
    expect([has(root, "b.txt"), has(root, "c.txt")]).toEqual([true, false]);
    await runtime.redo(signal());
    expect([has(root, "b.txt"), has(root, "c.txt")]).toEqual([true, true]);
    expect(runtime.rewindPoints).toHaveLength(3);

    // A resume reads the same state from the records.
    const records = await new FileSessionStore(root).read(runtime.session?.id as string);
    expect(rebuildState(records).undo.points).toHaveLength(3);
    runtime.executor.shutdown();
  });

  it("'No' changes nothing; a turn that does not exist says so", async () => {
    const { root, runtime } = await threeTurns("deny");
    expect(await runtime.rewind(1, signal())).toBe("Nothing changed.");
    expect(has(root, "c.txt")).toBe(true);
    expect(runtime.rewindPoints).toHaveLength(3);
    expect(await runtime.rewind(9, signal())).toBe(
      "There is no turn 9. Type /rewind for the list.",
    );
    runtime.executor.shutdown();
  });
});

describe("/rewind fork", () => {
  it("starts a new session with the messages up to turn 2; the old session does not change", async () => {
    const { root, runtime } = await threeTurns();
    const store = new FileSessionStore(root);
    const oldId = runtime.session?.id as string;
    const oldRecords = await store.read(oldId);
    const keep = runtime.session?.messages.slice(0, runtime.rewindPoints[1]?.messages);

    const said = await runtime.fork(2, signal());
    const newId = runtime.session?.id as string;
    expect(newId).not.toBe(oldId);
    expect(said).toContain(`New session ${newId}: the conversation up to turn 2 ("Add b.")`);
    expect(runtime.session?.messages).toEqual(keep);
    expect([has(root, "a.txt"), has(root, "b.txt"), has(root, "c.txt")]).toEqual([
      true,
      false,
      false,
    ]);
    expect(await store.read(oldId)).toEqual(oldRecords);

    const records = await store.read(newId);
    expect(records.map((r) => r.type)).toEqual(["start", "fork", "title"]);
    const state = rebuildState(records);
    expect(state.messages).toEqual(keep);
    expect(state.turns).toBe(1);
    expect(sessionMarkdown(records, newId)).toContain(
      `This session starts as a fork of session ${oldId}, at turn 2.`,
    );
    runtime.executor.shutdown();
  });

  it("'No' keeps the session and the files", async () => {
    const { root, runtime } = await threeTurns("deny");
    const id = runtime.session?.id;
    expect(await runtime.fork(1, signal())).toBe("Nothing changed.");
    expect(runtime.session?.id).toBe(id);
    expect(has(root, "a.txt")).toBe(true);
    runtime.executor.shutdown();
  });
});

describe("the /rewind list and command", () => {
  const point = (prompt: string, over: Partial<UndoPoint> = {}): UndoPoint => ({
    tree: "t",
    messages: 0,
    conversation: true,
    prompt,
    ...over,
  });

  it("lists the turns newest first with files, cost and age", () => {
    const now = 10 * 60_000;
    const list = rewindList(
      [
        point("explain the cart", { changedFiles: 0, costUsd: 0.0009, at: 0, conversation: false }),
        point("fix the key", { changedFiles: 2, costUsd: 0.0041, at: now - 30_000 }),
      ],
      now,
    ).split("\n");
    expect(list[0]).toBe("Rewind to the start of a turn (newest first):");
    expect(list[1]).toMatch(/^ {4}2 {2}"fix the key" +2 files +\$0\.0041 +<1 min$/);
    expect(list[2]).toMatch(
      /^ {4}1 {2}"explain the cart" +no files +\$0\.0009 +10 min {2}\(before a compaction: files only\)$/,
    );
    expect(rewindList([])).toBe("There is no turn to rewind to yet.");
    expect([ago(0, 3 * 3_600_000), ago(0, 3 * 86_400_000), ago(undefined, 0)]).toEqual([
      "3 h",
      "3 d",
      "",
    ]);
  });

  it("is a built-in command; a wrong argument shows the usage", async () => {
    expect(BUILTIN_COMMANDS).toContain("rewind");
    const { runtime } = await threeTurns();
    const store = new ChatStore({ model: "fake", sandbox: "none" }, { paint: noColor });
    const context = { runtime, renderer: store, sessionPath: (id: string) => id };
    await runCommand("/rewind", context);
    await runCommand("/rewind fork", context);
    await runCommand("/rewind two", context);
    const shown = store.getState().items.map((i) => i.text);
    expect(shown[0]).toContain('  3  "Add c."');
    expect(shown.slice(1)).toEqual([
      "Use: /rewind, /rewind <n> or /rewind fork <n>.",
      "Use: /rewind, /rewind <n> or /rewind fork <n>.",
    ]);
    runtime.executor.shutdown();
  });
});
