import { readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { editInEditor, editorCommand } from "../src/cli/chat/externalEditor.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { onKey } from "../src/cli/chat/ui.js";

/** Ink's key object with every flag off. */
const KEY = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  return: false,
  escape: false,
  ctrl: false,
  meta: false,
  tab: false,
  shift: false,
  backspace: false,
  delete: false,
};
const press = (store: ChatStore, input: string, key: Partial<typeof KEY> = {}) =>
  onKey(store, store.getState(), input, { ...KEY, ...key } as never);
const type = (store: ChatStore, text: string) => {
  for (const ch of text) press(store, ch);
};
const newStore = () => new ChatStore({ model: "m", sandbox: "s" }, { paint: (_s, t) => t });

describe("chat input (0.6)", () => {
  it("Esc stops a running turn once, drops the queue, and never exits", () => {
    const store = newStore();
    let stops = 0;
    store.begin("task");
    store.onInterrupt = () => stops++;
    store.enqueue("next");
    press(store, "", { escape: true });
    press(store, "", { escape: true });
    expect(stops).toBe(1);
    expect(store.getState().queue).toEqual([]);
    expect(store.getState().exiting).toBe(false);
    // A new turn can be stopped again.
    store.end({});
    store.begin("again");
    press(store, "", { escape: true });
    expect(stops).toBe(2);
  });

  it("Esc when idle only drops the queue; Ctrl-C then Esc does not stop twice", () => {
    const store = newStore();
    let stops = 0;
    store.onInterrupt = () => stops++;
    press(store, "", { escape: true });
    expect(stops).toBe(0);
    store.begin("task");
    press(store, "c", { ctrl: true });
    press(store, "", { escape: true });
    expect(stops).toBe(1);
  });

  it("backslash + Enter and Alt+Enter make a new line; Enter sends", async () => {
    const store = newStore();
    type(store, "first \\");
    press(store, "", { return: true });
    type(store, "second");
    press(store, "", { return: true, meta: true });
    type(store, "third");
    expect(store.getState().editor.text).toBe("first \nsecond\nthird");
    const sent = store.nextInput();
    press(store, "", { return: true });
    expect(await sent).toBe("first \nsecond\nthird");
  });

  it("Ctrl-G puts the edited text into the input line; it is not sent", () => {
    const store = newStore();
    type(store, "draft");
    const seen: string[] = [];
    store.externalEdit = (text) => {
      seen.push(text);
      return { text: "long\nprompt" };
    };
    press(store, "g", { ctrl: true });
    expect(seen).toEqual(["draft"]);
    expect(store.getState().editor.text).toBe("long\nprompt");
    expect(store.getState().busy).toBe(false);
    store.externalEdit = () => ({ problem: "vi ended with code 1; the line did not change." });
    press(store, "g", { ctrl: true });
    expect(store.getState().editor.text).toBe("long\nprompt");
    expect(JSON.stringify(store.getState().items)).toContain("vi ended with code 1");
  });

  it("without a terminal, the editor says so", () => {
    const store = newStore();
    store.openEditor();
    expect(JSON.stringify(store.getState().items)).toContain("only in the full chat");
  });
});

describe("the external editor (0.6)", () => {
  it("picks $VISUAL, then $EDITOR, then vi; quotes group words", () => {
    expect(editorCommand({ VISUAL: "code --wait", EDITOR: "nano" })).toEqual(["code", "--wait"]);
    expect(editorCommand({ EDITOR: '"/Applications/My Editor/bin/ed" -w' })).toEqual([
      "/Applications/My Editor/bin/ed",
      "-w",
    ]);
    expect(editorCommand({})).toEqual(["vi"]);
  });

  it("gives the saved text back, and cleans up the temp file", () => {
    let file = "";
    const result = editInEditor("start", {
      env: { EDITOR: "fake-editor" },
      run: (argv) => {
        expect(argv[0]).toBe("fake-editor");
        file = argv[1] as string;
        expect(readFileSync(file, "utf8")).toBe("start");
        writeFileSync(file, "start\nand more\n\n");
        return { exitCode: 0 };
      },
    });
    expect(result).toEqual({ text: "start\nand more" });
    expect(() => readFileSync(file)).toThrow();
  });

  it("reports a failed or missing editor", () => {
    expect(editInEditor("x", { env: { EDITOR: "vi" }, run: () => ({ exitCode: 1 }) })).toEqual({
      problem: "vi ended with code 1; the line did not change.",
    });
    expect(
      editInEditor("x", {
        env: { EDITOR: "nope" },
        run: () => ({ exitCode: null, error: "ENOENT" }),
      }).problem,
    ).toMatch(/Could not start nope: ENOENT/);
  });
});

describe("plain chat: a line ending with a backslash goes on (0.6)", () => {
  it("joins the lines into one task", async () => {
    const { runRepl } = await import("../src/cli/repl.js");
    const prompts: string[] = [];
    const runtime = {
      mode: "build",
      runTurn: async (prompt: string) => {
        prompts.push(prompt);
        return {
          stopReason: "done",
          steps: 1,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          apiMs: 0,
        };
      },
      session: undefined,
      limits: { maxSteps: 1, tokenBudget: 1, contextWindow: 1 },
      recordStop: () => {},
    };
    const input = new PassThrough();
    input.end("fix this \\\nand this\n");
    const silent = { event: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    await runRepl(
      runtime as never,
      { onInterrupt: () => {}, ask: async () => "deny" as const },
      silent,
      (id) => id,
      () => {
        throw new Error("exit");
      },
      { input, output: new PassThrough() },
    );
    expect(prompts).toEqual(["fix this \nand this"]);
  });
});
