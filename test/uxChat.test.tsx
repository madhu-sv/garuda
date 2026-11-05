import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { runChat } from "../src/cli/chat/controller.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { CONTINUE_PROMPT, SUMMARY_PROMPT } from "../src/cli/chat/stop.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { footerKeys, onKey } from "../src/cli/chat/ui.js";
import { contextBar, contextLevel, countChat, KEY_HINT_CHATS } from "../src/cli/uiState.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { ModelRequest } from "../src/model/types.js";
import { parseSettings } from "../src/permissions/settings.js";
import { FileSessionStore } from "../src/session/store.js";

/** UX U3 and U10 (docs/lld/ux.md): the step-limit question, the footer and `?`. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-uxchat-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let count = 0;
function folder(name: string): string {
  const dir = join(base, `${name}-${++count}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const texts = (store: ChatStore) => store.getState().items.map((i) => i.text);
const newStore = () =>
  new ChatStore({ model: "fake", sandbox: "sandbox test" }, { paint: noColor, keyHints: false });

/** Type a line and press Enter, as the user does. */
function send(store: ChatStore, line: string): void {
  store.editLine({ type: "insert", text: line });
  store.submitLine();
}

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The text of the last user message of a request. */
const lastPrompt = (request: ModelRequest | undefined) => {
  const message = request?.messages.filter((m) => m.role === "user").at(-1);
  return (message?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
};

describe("the step limit in the chat (UX U3)", () => {
  async function chatAt(model: FakeModelClient) {
    const root = folder("steps");
    writeFileSync(join(root, "a.js"), "1\n");
    const store = newStore();
    const runtime = await Runtime.create({
      root,
      modelId: "claude-sonnet-5",
      model: async () => model,
      approver: store,
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host", limits: { maxSteps: 1 } }),
      mcp: false,
      hooks: false,
      commands: false,
      profiles: [],
      onEvent: (e) => store.event(e),
    });
    const done = runChat(
      runtime,
      store,
      (id) => id,
      () => {
        throw new Error("exit");
      },
    );
    return { store, runtime, done };
  }

  it("asks how to go on; Enter (the first choice) runs a turn that goes on", async () => {
    const model = new FakeModelClient([
      reply([toolUse("glob", { pattern: "**/*.js" }, "g1")]),
      reply([text("Done now.")]),
    ]);
    const { store, runtime, done } = await chatAt(model);
    send(store, "Find the files.");
    await until(() => store.getState().approval !== undefined);
    expect(texts(store).join("\n")).toContain(
      "■ Stopped at the step limit (1). The task is not finished.",
    );
    expect(store.getState().approval?.request.question).toBe("Go on?");
    expect(store.getState().approval?.choices.map((c) => c.label)).toEqual([
      "Go on for 1 more steps",
      "Summarise what is done and what is left",
      "Stop here",
    ]);
    store.choose();
    await until(() => model.remaining === 0 && !store.getState().busy);
    expect(lastPrompt(model.requests.at(-1))).toContain(CONTINUE_PROMPT);
    send(store, "/exit");
    await done;
    runtime.executor.shutdown();
  });

  it("'Summarise' sends the summary prompt; 'Stop here' runs nothing more", async () => {
    const model = new FakeModelClient([
      reply([toolUse("glob", { pattern: "**/*.js" }, "g1")]),
      reply([text("Done: a. Left: b.")]),
      reply([toolUse("glob", { pattern: "**/*.js" }, "g2")]),
    ]);
    const { store, runtime, done } = await chatAt(model);
    send(store, "Find the files.");
    await until(() => store.getState().approval !== undefined);
    store.choose("session");
    await until(() => model.requests.length === 2 && !store.getState().busy);
    expect(lastPrompt(model.requests.at(-1))).toContain(SUMMARY_PROMPT);

    // The negative control: "Stop here" ends it, and the model gets no further request.
    send(store, "Again.");
    await until(() => store.getState().approval !== undefined);
    store.choose("deny");
    await until(() => !store.getState().busy && store.getState().approval === undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(model.requests).toHaveLength(3);
    send(store, "/exit");
    await done;
    runtime.executor.shutdown();
  });
});

describe("the receipt in the chat (UX U1)", () => {
  it("a turn that ran a command ends with the receipt, not the usage line", async () => {
    const root = folder("receipt");
    const store = newStore();
    const model = new FakeModelClient([
      reply([toolUse("bash", { command: "echo hi" }, "b1")]),
      reply([text("Said hi.")]),
    ]);
    const runtime = await Runtime.create({
      root,
      modelId: "claude-sonnet-5",
      model: async () => model,
      approver: store,
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      commands: false,
      profiles: [],
      onEvent: (e) => store.event(e),
    });
    const done = runChat(
      runtime,
      store,
      (id) => id,
      () => {
        throw new Error("exit");
      },
    );
    send(store, "Say hi.");
    // No OS sandbox (the host executor): the command asks first.
    await until(() => store.getState().approval !== undefined);
    store.choose("once");
    await until(() => model.remaining === 0 && !store.getState().busy);
    const all = texts(store).join("\n");
    expect(all).toMatch(/Turn 1 · done · 2 steps/);
    expect(all).toContain("1 outside");
    expect(all).not.toMatch(/\[done · 2 step\(s\)/);
    send(store, "/exit");
    await done;
    runtime.executor.shutdown();
  });
});

describe("the footer and the keys (UX U10)", () => {
  it("full key hints in the first chats, then only '? keys'; busy shows Esc", () => {
    expect(footerKeys(false, true)).toContain("Ctrl-P commands · ? keys");
    expect(footerKeys(false, false)).toBe("? keys");
    expect(footerKeys(true, false)).toBe("Esc stop · Ctrl-O output");
  });

  it("the context bar has ten cells and turns at 70% and 80%", () => {
    expect(contextBar(0)).toBe("░░░░░░░░░░");
    expect(contextBar(62)).toBe("▓▓▓▓▓▓░░░░");
    expect(contextBar(100)).toBe("▓▓▓▓▓▓▓▓▓▓");
    expect(contextBar(140)).toBe("▓▓▓▓▓▓▓▓▓▓");
    expect([contextLevel(69), contextLevel(70), contextLevel(80)]).toEqual(["ok", "high", "full"]);
  });

  it("'?' on an empty line shows every key and is not typed; in a text it is typed", () => {
    const store = newStore();
    const key = {} as never;
    onKey(store, store.getState(), "?", key);
    expect(texts(store).join("\n")).toContain("Keys:");
    expect(store.getState().editor.text).toBe("");
    onKey(store, store.getState(), "w", key);
    onKey(store, store.getState(), "?", key);
    expect(store.getState().editor.text).toBe("w?");
    expect(texts(store).filter((t) => t.includes("Keys:"))).toHaveLength(1);
  });

  it("counts chats in ~/.garuda/ui.json; a broken file starts again at 1", async () => {
    const home = folder("home");
    expect(await countChat(home)).toBe(1);
    expect(await countChat(home)).toBe(2);
    expect(JSON.parse(readFileSync(join(home, ".garuda", "ui.json"), "utf8"))).toEqual({
      chats: 2,
    });
    writeFileSync(join(home, ".garuda", "ui.json"), "{ broken");
    expect(await countChat(home)).toBe(1);
    expect(KEY_HINT_CHATS).toBe(5);
  });
});
