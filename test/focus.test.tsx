import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ChatStore } from "../src/cli/chat/store.js";
import { App, onKey } from "../src/cli/chat/ui.js";
import { FocusTracker, focusEvent, reportsFocus } from "../src/cli/focus.js";
import { Notifier } from "../src/cli/notify.js";
import type { ApprovalRequest } from "../src/permissions/types.js";

const newStore = () => new ChatStore({ model: "m", sandbox: "s" }, { paint: (_s, t) => t });
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
const DONE = {
  kind: "done" as const,
  result: {
    stopReason: "done" as const,
    steps: 1,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    apiMs: 0,
  },
};
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe("terminal focus (0.6)", () => {
  it("reads focus events, with or without ESC; other input is not one", () => {
    expect(focusEvent("[I")).toBe(true);
    expect(focusEvent("\x1b[O")).toBe(false);
    expect(focusEvent("I")).toBeUndefined();
    expect(focusEvent("[I am")).toBeUndefined();
  });

  it("only terminals that report focus, and not inside tmux or screen", () => {
    expect(reportsFocus({ TERM_PROGRAM: "iTerm.app" })).toBe(true);
    expect(reportsFocus({ TERM_PROGRAM: "ghostty" })).toBe(true);
    expect(reportsFocus({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
    expect(reportsFocus({ TERM_PROGRAM: "iTerm.app", TMUX: "x" })).toBe(false);
    expect(reportsFocus({ TERM_PROGRAM: "WezTerm", TERM: "screen-256color" })).toBe(false);
  });

  it("the notifier stays quiet while the window has focus", () => {
    const focus = new FocusTracker();
    const sent: string[] = [];
    const notifier = new Notifier(
      "osc9",
      (b) => sent.push(b),
      0,
      () => focus.focused,
    );
    const request: ApprovalRequest = {
      tool: "bash",
      target: { kind: "command", command: "npm test" },
      preview: "npm test",
      isolation: "none",
    };
    notifier.turnStarted();
    notifier.approval(request);
    notifier.turnEnded(DONE, 20_000);
    expect(sent).toEqual([]);
    focus.update(false);
    notifier.turnStarted();
    notifier.approval(request);
    notifier.turnEnded(DONE, 20_000);
    expect(sent).toHaveLength(2);
    // Without focus reporting the state is unknown: every notification goes.
    const always: string[] = [];
    const plain = new Notifier("bell", (b) => always.push(b), 0);
    plain.turnStarted();
    plain.turnEnded(DONE, 1);
    expect(always).toEqual(["\x07"]);
  });

  it("focus events never reach the input line", () => {
    const store = newStore();
    const seen: boolean[] = [];
    store.onFocus = (f) => seen.push(f);
    onKey(store, store.getState(), "[O", KEY);
    onKey(store, store.getState(), "a", KEY);
    onKey(store, store.getState(), "[I", KEY);
    expect(store.getState().editor.text).toBe("a");
    expect(seen).toEqual([false, true]);
  });

  it("in the real Ink input: the codes go to the tracker, typed text to the line", async () => {
    const store = newStore();
    const focus = new FocusTracker();
    store.onFocus = (f) => focus.update(f);
    const ui = render(<App store={store} />);
    ui.stdin.write("h");
    ui.stdin.write("\x1b[O");
    await until(() => focus.focused === false);
    ui.stdin.write("i");
    ui.stdin.write("\x1b[I");
    await until(() => focus.focused === true);
    await until(() => store.getState().editor.text === "hi");
    ui.unmount();
  });
});
