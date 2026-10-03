import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { runCommand } from "../src/cli/chat/commands.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { BUILTIN_COMMANDS } from "../src/commands/builtins.js";
import { replaySession } from "../src/loop/replay.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { Message } from "../src/model/types.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../src/permissions/types.js";
import { HostExecutor } from "../src/sandbox/host.js";
import type { ExecPolicy } from "../src/sandbox/types.js";
import { rebuildState } from "../src/session/resume.js";
import {
  addAssistantResponse,
  addSnapshot,
  addUserMessage,
  createSession,
  redoTurn,
  undoTurn,
} from "../src/session/session.js";
import { FileSessionStore, MemoryJournal } from "../src/session/store.js";
import { compacted } from "../src/session/undo.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { undoQuestion } from "../src/undo/question.js";
import { SnapshotError, SnapshotStore, storeDir } from "../src/undo/snapshots.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-undo-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let count = 0;
function folder(name: string): string {
  const dir = join(base, `${name}-${++count}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const read = (path: string) => readFileSync(path, "utf8");
const signal = () => new AbortController().signal;
const T1 = "a".repeat(40);
const T2 = "b".repeat(40);
const T3 = "c".repeat(40);

class Recorder implements Approver {
  readonly requests: ApprovalRequest[] = [];
  constructor(
    private readonly answer: ApprovalChoice = "once",
    /** The answer to the undo and redo questions, when it differs. */
    private readonly undoAnswer: ApprovalChoice = answer,
  ) {}
  async ask(request: ApprovalRequest): Promise<ApprovalChoice> {
    this.requests.push(request);
    return request.tool === "undo" || request.tool === "redo" ? this.undoAnswer : this.answer;
  }
}

describe("the snapshot store (0.4)", () => {
  const store = (root: string, maxFiles?: number) =>
    new SnapshotStore(root, new HostExecutor(), join(folder("home"), "store"), maxFiles);

  it("takes snapshots, lists the changes and restores added, changed and deleted files", async () => {
    const root = folder("p");
    writeFileSync(join(root, "a.txt"), "one\n");
    writeFileSync(join(root, "gone.txt"), "old\n");
    const s = store(root);
    const before = await s.take();
    writeFileSync(join(root, "a.txt"), "two\n");
    rmSync(join(root, "gone.txt"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "new.ts"), "x\n");
    const after = await s.take();
    expect(after).not.toBe(before);
    expect(await s.changes(before, after)).toEqual([
      { status: "modified", path: "a.txt" },
      { status: "deleted", path: "gone.txt" },
      { status: "added", path: "src/new.ts" },
    ]);
    await s.restore(after, before);
    expect(read(join(root, "a.txt"))).toBe("one\n");
    expect(read(join(root, "gone.txt"))).toBe("old\n");
    expect(existsSync(join(root, "src", "new.ts"))).toBe(false);
    await s.restore(before, after);
    expect(read(join(root, "src", "new.ts"))).toBe("x\n");
    expect(existsSync(join(root, "gone.txt"))).toBe(false);
  });

  it("follows .gitignore, skips Garuda's records, and never touches the project's own git", async () => {
    const root = folder("git");
    // Tests start processes through the Executor too (N8).
    const host = new HostExecutor();
    const policy: ExecPolicy = {
      root,
      sandbox: false,
      writePaths: [],
      denyWritePaths: [],
      denyReadPaths: [],
      network: false,
      envAllowlist: ["PATH", "HOME"],
      timeoutMs: 30_000,
      maxOutputBytes: 100_000,
    };
    const git = async (...args: string[]) =>
      (await host.run(`git -c user.name=t -c user.email=t@t ${args.join(" ")}`, policy)).stdout
        .text;
    await git("init", "-q");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    writeFileSync(join(root, "a.txt"), "one\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "first");
    writeFileSync(join(root, "a.txt"), "mine, not committed\n");
    const status = await git("status", "--porcelain");
    const head = await git("rev-parse", "HEAD");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "big.js"), "x");
    mkdirSync(join(root, ".garuda", "sessions"), { recursive: true });
    writeFileSync(join(root, ".garuda", "sessions", "s.jsonl"), "{}\n");
    writeFileSync(join(root, ".garuda", "memory.md"), "fact\n");

    const s = store(root);
    const before = await s.take();
    writeFileSync(join(root, "node_modules", "big.js"), "y");
    writeFileSync(join(root, ".garuda", "sessions", "s.jsonl"), "{}\n{}\n");
    writeFileSync(join(root, ".garuda", "memory.md"), "fact\nnew fact\n");
    const after = await s.take();
    expect(await s.changes(before, after)).toEqual([
      { status: "modified", path: ".garuda/memory.md" },
    ]);
    await s.restore(after, before);
    expect(read(join(root, ".garuda", "sessions", "s.jsonl"))).toBe("{}\n{}\n");
    expect(read(join(root, "node_modules", "big.js"))).toBe("y");
    expect(await git("status", "--porcelain")).toBe(`${status}?? .garuda/\n`);
    expect(await git("rev-parse", "HEAD")).toBe(head);
    expect(read(join(root, "a.txt"))).toBe("mine, not committed\n");
  });

  it("refuses to restore over a file that changed after the snapshot", async () => {
    const root = folder("race");
    writeFileSync(join(root, "a.txt"), "one\n");
    const s = store(root);
    const before = await s.take();
    writeFileSync(join(root, "a.txt"), "two\n");
    const now = await s.take();
    writeFileSync(join(root, "a.txt"), "three, typed by the user\n");
    await expect(s.restore(now, before)).rejects.toBeInstanceOf(SnapshotError);
    expect(read(join(root, "a.txt"))).toBe("three, typed by the user\n");
  });

  it("refuses a project with too many files, and bad ids", async () => {
    const root = folder("big");
    for (let i = 0; i < 5; i++) writeFileSync(join(root, `f${i}.txt`), `${i}`);
    await expect(store(root, 3).take()).rejects.toThrow(/has 5 files \(more than 3\)/);
    const s = store(root);
    await expect(s.changes("HEAD; rm -rf /", T1)).rejects.toThrow(/Not a snapshot id/);
  });

  it("keeps one private store per project folder under ~/.garuda/snapshots", async () => {
    const home = folder("home");
    expect(storeDir("/p/a", home)).toMatch(/\/\.garuda\/snapshots\/[0-9a-f]{16}$/);
    expect(storeDir("/p/a", home)).not.toBe(storeDir("/p/b", home));
    const root = folder("mode");
    writeFileSync(join(root, "a.txt"), "x");
    const s = new SnapshotStore(root, new HostExecutor(), storeDir(root, home));
    await s.take();
    expect(statSync(s.dir).mode & 0o777).toBe(0o700);
  });
});

describe("undo in the conversation (0.4)", () => {
  const turn = (session: ReturnType<typeof createSession>, tree: string, prompt: string) => {
    addSnapshot(session, tree, prompt, 5);
    addUserMessage(session, prompt);
    addAssistantResponse(session, reply([text(`did ${prompt}`)]), 1, 0);
  };

  it("undo takes the turn out, redo brings it back, and the records rebuild the same state", () => {
    const journal = new MemoryJournal();
    const session = createSession("/r", "s", journal);
    turn(session, T1, "first task");
    turn(session, T2, "second task");
    expect(session.messages).toHaveLength(4);
    const point = undoTurn(session, T3);
    expect(point).toMatchObject({ tree: T2, messages: 2, prompt: "second task" });
    expect(session.messages).toHaveLength(2);
    expect(rebuildState(journal.records).messages).toEqual(session.messages);
    expect(rebuildState(journal.records).undo).toEqual(session.undo);
    expect(redoTurn(session)).toMatchObject({ after: T3 });
    expect(session.messages).toHaveLength(4);
    expect(rebuildState(journal.records).messages).toEqual(session.messages);
    undoTurn(session, T3);
    undoTurn(session, T3);
    expect(session.messages).toEqual([]);
    expect(undoTurn(session, T3)).toBeUndefined();
  });

  it("a new prompt ends the redo chain; a compaction keeps the files but not the messages", () => {
    const session = createSession("/r", "s");
    turn(session, T1, "first");
    undoTurn(session, T2);
    addUserMessage(session, "something else");
    expect(redoTurn(session)).toBeUndefined();
    turn(session, T1, "a");
    turn(session, T2, "b");
    compacted(session.undo);
    const summary: Message[] = [{ role: "user", content: [{ type: "text", text: "summary" }] }];
    session.messages = summary;
    expect(undoTurn(session, T3)).toMatchObject({ conversation: false });
    expect(session.messages).toBe(summary);
  });

  it("the prompt in the question is one short line", () => {
    const session = createSession("/r", "s");
    addSnapshot(session, T1, `fix\n\nthe   bug ${"x".repeat(100)}`, 1);
    expect(session.undo.points[0]?.prompt).toBe(`fix the bug ${"x".repeat(68)}…`);
  });
});

describe("/undo and /redo in a session (0.4)", () => {
  async function runtimeFor(
    root: string,
    model: FakeModelClient,
    approver: Approver,
    resume?: true,
  ) {
    return Runtime.create({
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
      undo: { home: join(root, "..", "home") },
      ...(resume === undefined ? {} : { resume }),
    });
  }

  it("undo restores the files of the last turn, even a command's, and the model forgets it", async () => {
    const root = folder("session");
    writeFileSync(join(root, "a.txt"), "one\n");
    const model = new FakeModelClient([
      reply([toolUse("read_file", { path: "a.txt" }, "t1")]),
      reply([toolUse("edit_file", { path: "a.txt", old_string: "one", new_string: "two" }, "t2")]),
      reply([toolUse("bash", { command: "echo made > made.txt" }, "t3")]),
      reply([text("Done.")]),
    ]);
    const approver = new Recorder("once");
    const runtime = await runtimeFor(root, model, approver);
    expect(runtime.undoEnabled).toBe(true);
    await runtime.runTurn("Change a to two.", signal());
    expect(read(join(root, "a.txt"))).toBe("two\n");
    expect(existsSync(join(root, "made.txt"))).toBe(true);
    const turnMessages = runtime.session?.messages.length;

    const said = await runtime.undo(signal());
    expect(said).toBe(
      'Undid "Change a to two.": 2 files changed; the conversation went back too. /redo brings it back.',
    );
    const question = approver.requests.at(-1);
    expect(question).toMatchObject({ title: "Undo the last turn?", question: "Undo it?" });
    expect(question?.preview).toContain("~ a.txt");
    expect(question?.preview).toContain("- made.txt");
    expect(read(join(root, "a.txt"))).toBe("one\n");
    expect(existsSync(join(root, "made.txt"))).toBe(false);
    expect(runtime.session?.messages).toEqual([]);

    expect(await runtime.redo(signal())).toBe('Redid "Change a to two.": 2 files changed.');
    expect(read(join(root, "a.txt"))).toBe("two\n");
    expect(runtime.session?.messages).toHaveLength(turnMessages as number);
    expect(await runtime.redo(signal())).toBe("There is nothing to redo.");
    runtime.executor.shutdown();
  });

  it("'No' changes nothing; after a resume the last turn can still be undone", async () => {
    const root = folder("resume");
    writeFileSync(join(root, "a.txt"), "one\n");
    const model = new FakeModelClient([
      reply([toolUse("write_file", { path: "b.txt", content: "new\n" }, "t1")]),
      reply([text("Done.")]),
    ]);
    const first = await runtimeFor(root, model, new Recorder("once", "deny"));
    await first.runTurn("Add b.", signal());
    expect(await first.undo(signal())).toBe("Nothing changed.");
    expect(existsSync(join(root, "b.txt"))).toBe(true);
    first.executor.shutdown();

    const second = await runtimeFor(root, new FakeModelClient([]), new Recorder("once"), true);
    expect(await second.undo(signal())).toMatch(/^Undid "Add b\.": 1 file changed/);
    expect(existsSync(join(root, "b.txt"))).toBe(false);
    expect(await second.undo(signal())).toBe("There is no turn to undo.");
    second.executor.shutdown();
  });

  it("a snapshot that is gone gives a clear failure, and no file changes", async () => {
    const root = folder("gone");
    writeFileSync(join(root, "a.txt"), "one\n");
    const model = new FakeModelClient([
      reply([toolUse("write_file", { path: "b.txt", content: "new\n" }, "t1")]),
      reply([text("Done.")]),
    ]);
    const runtime = await runtimeFor(root, model, new Recorder("once"));
    await runtime.runTurn("Add b.", signal());
    rmSync(storeDir(root, join(root, "..", "home")), { recursive: true, force: true });
    expect(await runtime.undo(signal())).toMatch(
      /^The undo failed, and no file changed: git failed: /,
    );
    expect(read(join(root, "b.txt"))).toBe("new\n");
    runtime.executor.shutdown();
  });

  it("the chat commands; off without the option or with the setting", async () => {
    expect(BUILTIN_COMMANDS).toEqual(expect.arrayContaining(["undo", "redo"]));
    const root = folder("chat");
    const runtime = await runtimeFor(root, new FakeModelClient([]), new Recorder());
    const store = new ChatStore({ model: "fake", sandbox: "none" }, { paint: noColor });
    const context = { runtime, renderer: store, sessionPath: (id: string) => id };
    await runCommand("/undo", context);
    await runCommand("/redo", context);
    expect(store.getState().items.map((i) => i.text)).toEqual([
      "There is no turn to undo.",
      "There is nothing to redo.",
    ]);
    const plain = await Runtime.create({
      root,
      modelId: "fake",
      model: new FakeModelClient([]),
      approver: new Recorder(),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      commands: false,
      profiles: [],
    });
    expect(plain.undoEnabled).toBe(false);
    expect(await plain.undo(signal())).toBe("Undo is off for this session.");
    const off = await Runtime.create({
      root,
      modelId: "fake",
      model: new FakeModelClient([]),
      approver: new Recorder(),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host", undo: { enabled: false } }),
      mcp: false,
      hooks: false,
      commands: false,
      profiles: [],
      undo: {},
    });
    expect(off.undoEnabled).toBe(false);
  });

  it("a failing snapshot turns undo off with one notice; the turn still runs", async () => {
    const root = folder("fail");
    for (let i = 0; i < 3; i++) writeFileSync(join(root, `f${i}`), "x");
    const notices: string[] = [];
    const home = folder("home");
    // A file where the store folder should be: git cannot create it.
    mkdirSync(join(home, ".garuda"), { recursive: true });
    writeFileSync(join(home, ".garuda", "snapshots"), "not a folder");
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: new FakeModelClient([reply([text("Hi.")])]),
      approver: new Recorder(),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      commands: false,
      profiles: [],
      undo: { home },
      onNotice: (t) => notices.push(t),
    });
    expect((await runtime.runTurn("hello", signal())).stopReason).toBe("done");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^Undo is off for this session: /);
    expect(runtime.undoEnabled).toBe(false);
    runtime.executor.shutdown();
  });

  it("replay applies the undo between runs", async () => {
    const root = folder("replay");
    writeFileSync(join(root, "a.txt"), "one\n");
    const model = new FakeModelClient([
      reply([text("First.")]),
      reply([text("Second.")]),
      reply([text("Third.")]),
    ]);
    const runtime = await runtimeFor(root, model, new Recorder("once"));
    await runtime.runTurn("one", signal());
    await runtime.runTurn("two", signal());
    await runtime.undo(signal());
    await runtime.runTurn("three", signal());
    const id = runtime.session?.id as string;
    const records = await new FileSessionStore(root).read(id);
    expect(rebuildState(records).messages.map((m) => m.content[0])).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "First." },
      { type: "text", text: "three" },
      { type: "text", text: "Third." },
    ]);
    const report = await replaySession(records, new ToolRegistry(defaultTools()));
    expect(report).toMatchObject({ matches: true, runs: 3 });
    runtime.executor.shutdown();
  });
});

describe("the undo question (0.4)", () => {
  it("lists the files, cleans their names, and says what happens to the conversation", () => {
    const q = undoQuestion(
      "undo",
      "fix it",
      [
        { status: "modified", path: "a.ts" },
        { status: "added", path: "b\u001b[31m.ts" },
      ],
      false,
      "os",
    );
    expect(q.preview).toBe(
      [
        'Turn: "fix it"',
        "Files (2):",
        "  ~ a.ts",
        "  + b.ts",
        "  (+ comes back, - is removed, ~ changes)",
        "Files that .gitignore covers (for example build output) are not in undo.",
        "The conversation was compacted, so it keeps the turn; the model gets a note.",
        "Changes that you made to these files after the turn go back too. /redo brings everything back.",
      ].join("\n"),
    );
    expect(q.choices).toEqual(["once", "deny"]);
    const many = Array.from({ length: 35 }, (_, i) => ({
      status: "added" as const,
      path: `f${i}`,
    }));
    expect(undoQuestion("redo", "x", many, true, "os").preview).toContain("  … and 5 more.");
  });
});
