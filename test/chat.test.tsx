import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { runChat } from "../src/cli/chat/controller.js";
import { edit, emptyEditor, submit } from "../src/cli/chat/lineEditor.js";
import { noColor, renderMarkdown, takeBlocks } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { App, typeAhead } from "../src/cli/chat/ui.js";
import { SUMMARY_SYSTEM } from "../src/context/compact.js";
import type { AgentEvent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { ModelClient } from "../src/model/types.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { ApprovalRequest } from "../src/permissions/types.js";
import { FileSessionStore } from "../src/session/store.js";

const status = { model: "fake", sandbox: "sandbox test" };
const newStore = (now?: () => number) =>
  new ChatStore(status, { paint: noColor, ...(now ? { now } : {}) });
const texts = (store: ChatStore) => store.getState().items.map((i) => i.text);

describe("markdown", () => {
  it("cuts finished blocks at blank lines, but not inside code fences", () => {
    expect(takeBlocks("one\ntwo\n\nthree")).toEqual({ blocks: ["one\ntwo"], rest: "three" });
    expect(takeBlocks("```js\na\n\nb\n")).toEqual({ blocks: [], rest: "```js\na\n\nb\n" });
    expect(takeBlocks("```js\na\n\nb\n```\nnext")).toEqual({
      blocks: ["```js\na\n\nb\n```"],
      rest: "next",
    });
  });

  it("styles headings, lists, quotes, code and inline marks", () => {
    const out = renderMarkdown(
      "# Title\n- item with `code`\n> quote\n```\nconst a = 1;\n```\n**bold** [site](https://x.io)",
      noColor,
    );
    expect(out).toBe("Title\n• item with code\n│ quote\n  const a = 1;\nbold site (https://x.io)");
  });
});

describe("line editor", () => {
  it("edits at the cursor", () => {
    let s = edit(emptyEditor(), { type: "insert", text: "hello world" });
    s = edit(s, { type: "deleteWord" });
    expect(s.text).toBe("hello ");
    s = edit(s, { type: "home" });
    s = edit(s, { type: "insert", text: ">" });
    expect([s.text, s.cursor]).toEqual([">hello ", 1]);
    s = edit(s, { type: "backspace" });
    expect(s.text).toBe("hello ");
  });

  it("keeps history, newest first, and restores the draft", () => {
    let s = submit(edit(emptyEditor(), { type: "insert", text: "first" })).state;
    s = submit(edit(s, { type: "insert", text: "second" })).state;
    s = edit(s, { type: "insert", text: "draft" });
    s = edit(s, { type: "up" });
    expect(s.text).toBe("second");
    s = edit(s, { type: "up" });
    expect(s.text).toBe("first");
    s = edit(s, { type: "down" });
    s = edit(s, { type: "down" });
    expect(s.text).toBe("draft");
  });
});

describe("chat store", () => {
  const call = toolUse("read_file", { path: "a.js" }, "t1");
  const event = (e: AgentEvent) => e;

  it("prints text by blocks, and tools when they finish", () => {
    const store = newStore();
    store.begin("task");
    store.event(event({ type: "text_delta", text: "# Plan\n\nLook at " }));
    expect(store.getState().streaming).toBe("Look at ");
    store.event(event({ type: "tool_call", call }));
    expect(store.getState().running).toEqual([{ id: "t1", line: "read_file a.js" }]);
    store.event(
      event({ type: "tool_result", call, outcome: { content: "1\tline", isError: false } }),
    );
    expect(store.getState().running).toEqual([]);
    expect(texts(store)).toEqual(["task", "Plan", "Look at", "● read_file a.js\n  ⎿ 1 line(s)"]);
    store.showLastOutput();
    expect(texts(store).at(-1)).toBe("read_file a.js\n1\tline");
  });

  it("queues lines typed during a turn, and hands them out in order", async () => {
    const store = newStore();
    store.begin("task");
    store.editLine({ type: "insert", text: "next one" });
    store.submitLine();
    store.editLine({ type: "insert", text: "and this" });
    store.submitLine();
    expect(store.getState().queue).toEqual(["next one", "and this"]);
    store.end({});
    expect(await store.nextInput()).toBe("next one");
    store.clearQueue();
    expect(store.getState().queue).toEqual([]);
  });

  it("Ctrl-C stops a turn; at the prompt it clears the line, then exits on a second press", async () => {
    let t = 0;
    const store = newStore(() => t);
    let stopped = 0;
    store.onInterrupt = () => stopped++;
    store.begin("task");
    store.interrupt();
    expect(stopped).toBe(1);
    store.end({});

    const next = store.nextInput();
    store.editLine({ type: "insert", text: "x" });
    store.interrupt();
    expect(store.getState().editor.text).toBe("");
    t = 10_000;
    store.interrupt();
    t = 10_500;
    store.interrupt();
    expect(await next).toBeUndefined();
  });

  it("asks for approval: the preview goes to the scrollback, the answer to the promise", async () => {
    const store = newStore();
    const request: ApprovalRequest = {
      tool: "bash",
      target: { kind: "command", command: "curl x", outsideSandbox: true },
      preview: "curl x",
      isolation: "os",
    };
    const answer = store.ask(request, new AbortController().signal);
    expect(texts(store).join("\n")).toContain("OUTSIDE the sandbox");
    store.moveApproval(1);
    store.choose();
    expect(await answer).toBe("session");
    expect(store.getState().approval).toBeUndefined();

    const controller = new AbortController();
    const aborted = store.ask(request, controller.signal);
    controller.abort(new Error("stop"));
    await expect(aborted).rejects.toThrow("stop");
  });
});

describe("keys typed before the chat was ready", () => {
  it("treats each line end in a chunk as Enter", async () => {
    const store = newStore();
    const first = store.nextInput();
    typeAhead(store, "run tests\nand lint\r\n");
    expect(await first).toBe("run tests");
    expect(store.getState().queue).toEqual(["and lint"]);
    expect(await store.nextInput()).toBe("and lint");
  });
});

describe("Ink chat", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "garuda-chat-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.js"), "export const a = 1;\n");

  const until = async (check: () => boolean) => {
    const end = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("runs typed tasks and commands, and draws the result", async () => {
    const model = new FakeModelClient([
      reply([text("Let me look.\n\n"), toolUse("glob", { pattern: "**/*.js" }, "g1")]),
      reply([text("There is **one** file: `src/a.js`.")]),
    ]);
    const store = newStore();
    const runtime = await Runtime.create({
      root,
      modelId: "claude-sonnet-5",
      model: async () => model,
      approver: store,
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      onEvent: (e) => store.event(e),
    });
    const ui = render(<App store={store} />);
    const done = runChat(
      runtime,
      store,
      (id) => id,
      () => {
        throw new Error("exit");
      },
    );

    for (const ch of "What files?") ui.stdin.write(ch);
    await until(() => (ui.lastFrame() ?? "").includes("What files?"));
    ui.stdin.write("\r");
    await until(() => model.remaining === 0 && !store.getState().busy);

    const all = texts(store).join("\n");
    expect(all).toContain("What files?");
    expect(all).toContain("● glob **/*.js");
    expect(all).toContain("There is one file: src/a.js.");
    expect(all).toMatch(/\[done · 2 step\(s\)/);
    await until(() => (ui.lastFrame() ?? "").includes("context"));

    for (const ch of "/exit") ui.stdin.write(ch);
    await until(() => (ui.lastFrame() ?? "").includes("/exit"));
    ui.stdin.write("\r");
    await done;
    ui.unmount();
  });
  it("/compact is busy while the model summarises, and Esc stops it (0.8)", async () => {
    const fake = new FakeModelClient([1, 2, 3, 4, 5].map((i) => reply([text(`A${i}`)])));
    let summaryAsked = false;
    // The summary request waits until Esc aborts it.
    const model: ModelClient = {
      async *stream(request, options) {
        if (request.system !== SUMMARY_SYSTEM) {
          yield* fake.stream(request, options);
          return;
        }
        summaryAsked = true;
        await new Promise((_, reject) =>
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason)),
        );
      },
    };
    const store = newStore();
    const runtime = await Runtime.create({
      root,
      modelId: "claude-sonnet-5",
      model: async () => model,
      approver: store,
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      onEvent: (e) => store.event(e),
    });
    for (const i of [1, 2, 3, 4, 5]) await runtime.runTurn(`t${i}`, new AbortController().signal);
    const before = JSON.stringify(runtime.session?.messages);
    const ui = render(<App store={store} />);
    const done = runChat(
      runtime,
      store,
      (id) => id,
      () => {
        throw new Error("exit");
      },
    );
    for (const ch of "/compact") ui.stdin.write(ch);
    await until(() => (ui.lastFrame() ?? "").includes("/compact"));
    ui.stdin.write("\r");
    await until(() => summaryAsked && store.getState().busy);
    ui.stdin.write("\u001b");
    await until(() => !store.getState().busy);
    expect(texts(store).at(-1)).toBe("Compaction stopped. The conversation did not change.");
    expect(JSON.stringify(runtime.session?.messages)).toBe(before);

    for (const ch of "/exit") ui.stdin.write(ch);
    await until(() => (ui.lastFrame() ?? "").includes("/exit"));
    ui.stdin.write("\r");
    await done;
    ui.unmount();
  });
});
