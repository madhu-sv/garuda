import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ChatStore } from "../src/cli/chat/store.js";
import { App } from "../src/cli/chat/ui.js";
import { FocusTracker, focusEvent, reportsFocus, watchFocus } from "../src/cli/focus.js";
import { Notifier } from "../src/cli/notify.js";
import type { ApprovalRequest } from "../src/permissions/types.js";

const newStore = () => new ChatStore({ model: "m", sandbox: "s" }, { paint: (_s, t) => t });
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
  it("reads the focus event from a raw chunk; the last one wins; other input is not one", () => {
    expect(focusEvent("\x1b[I")).toBe(true);
    expect(focusEvent("\x1b[O")).toBe(false);
    // A chunk can carry typed text around the sequence, or two events; the last state wins.
    expect(focusEvent("hi\x1b[I")).toBe(true);
    expect(focusEvent("\x1b[O\x1b[I")).toBe(true);
    expect(focusEvent("I")).toBeUndefined();
    expect(focusEvent("[I without esc")).toBeUndefined();
  });

  it("watchFocus reads focus from stdin and detaches", () => {
    const stdin = new EventEmitter();
    const seen: boolean[] = [];
    const stop = watchFocus(stdin as never, (f) => seen.push(f));
    stdin.emit("data", Buffer.from("\x1b[O"));
    stdin.emit("data", "a"); // plain input: no event
    stdin.emit("data", Buffer.from("\x1b[I"));
    expect(seen).toEqual([false, true]);
    stop();
    stdin.emit("data", Buffer.from("\x1b[O"));
    expect(seen).toEqual([false, true]); // nothing after detach
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
