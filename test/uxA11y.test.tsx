import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { ACCENT_HEX, accentAnsi, accentInk } from "../src/cli/accent.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { planText } from "../src/cli/chat/toolGroups.js";
import {
  App,
  choiceText,
  contextText,
  STILL_FRAME,
  sandboxText,
  workingText,
} from "../src/cli/chat/ui.js";
import { marks, motionReduced } from "../src/cli/marks.js";
import { receiptText } from "../src/cli/receiptView.js";
import { PlainRenderer, todoLines } from "../src/cli/renderer.js";
import { toolUse } from "../src/model/fake.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { ApprovalRequest } from "../src/permissions/types.js";

/**
 * UX U12 (patch 8): reduced motion, the rest of screen-reader mode, and the brand accent.
 */

const before = process.env.GARUDA_SCREEN_READER;
const screenReader = (on: boolean) => {
  if (on) process.env.GARUDA_SCREEN_READER = "1";
  else delete process.env.GARUDA_SCREEN_READER;
};
afterEach(() => {
  if (before === undefined) delete process.env.GARUDA_SCREEN_READER;
  else process.env.GARUDA_SCREEN_READER = before;
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BRAILLE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

describe("the accent", () => {
  it("is the banner's saffron with true color, yellow with 16 colors, and nothing without color", () => {
    expect(ACCENT_HEX).toBe("#ff7a18");
    expect(accentInk("truecolor")).toBe("#ff7a18");
    expect(accentInk("basic")).toBe("yellow");
    expect(accentInk("none")).toBeUndefined();
    expect(accentAnsi("x", "truecolor")).toBe("\u001b[38;2;255;122;24mx\u001b[39m");
    expect(accentAnsi("x", "basic")).toBe("\u001b[33mx\u001b[39m");
    expect(accentAnsi("x", "none")).toBe("x");
  });

  it("draws the receipt border and the plan's current step", () => {
    const seen: string[] = [];
    const paint = (style: string, text: string) => {
      seen.push(style);
      return text;
    };
    const receipt = {
      turn: 1,
      stopReason: "done",
      steps: 2,
      durationMs: 1_000,
      costUsd: 0.01,
      files: [{ path: "a.ts", added: 1, removed: 0 }],
      commands: { sandboxed: 1, outside: 0, blockedHosts: [] },
    };
    receiptText(receipt as never, { columns: 80, paint });
    expect(seen).toContain("accent");
    expect(seen).not.toContain("yellow");
    const styles: string[] = [];
    planText(["✔ one", "▶ two", "○ three"], (style, text) => {
      styles.push(String(style));
      return text;
    });
    expect(styles).toEqual(["green", "accent", "dim", "bold"]);
  });
});

describe("reduced motion", () => {
  it("comes from GARUDA_MOTION, the project's ui.motion, or screen-reader mode", () => {
    expect(motionReduced({})).toBe(false);
    expect(motionReduced({ GARUDA_MOTION: "reduce" })).toBe(true);
    expect(motionReduced({ GARUDA_MOTION: "full" })).toBe(false);
    expect(motionReduced({}, { motion: "reduce" })).toBe(true);
    expect(motionReduced({ GARUDA_SCREEN_READER: "1" })).toBe(true);
    expect(parseSettings({ ui: { motion: "reduce" } }).ui).toEqual({ motion: "reduce" });
    expect(() => parseSettings({ ui: { motion: "slow" } })).toThrow();
  });

  it("draws no spinner frames: the live line counts seconds", async () => {
    const store = new ChatStore(
      { model: "m", sandbox: "sandbox test" },
      { paint: noColor, keyHints: false, reducedMotion: true },
    );
    const ui = render(<App store={store} />);
    store.begin("work", false);
    await wait(1_150);
    const frames = ui.frames.join("\n");
    expect(frames).toContain(workingText(1));
    expect(frames).not.toMatch(BRAILLE);
    // A running tool has the still mark.
    store.event({ type: "tool_call", call: toolUse("bash", { command: "sleep 1" }, "s") } as never);
    await wait(150);
    expect(ui.lastFrame()).toContain(`${STILL_FRAME} `);
    expect(ui.frames.join("\n")).not.toMatch(BRAILLE);
    ui.unmount();
  });

  it("without it, the spinner turns (the negative control)", async () => {
    const store = new ChatStore(
      { model: "m", sandbox: "sandbox test" },
      { paint: noColor, keyHints: false, reducedMotion: false },
    );
    const ui = render(<App store={store} />);
    store.begin("work", false);
    await wait(250);
    expect(ui.frames.join("\n")).toMatch(BRAILLE);
    ui.unmount();
    expect(STILL_FRAME).toBe("•");
  });
});

describe("screen-reader mode", () => {
  it("uses words for the marks", () => {
    expect(marks(false)).toMatchObject({ call: "●", result: "⎿", now: "▶" });
    expect(marks(true)).toMatchObject({ call: "Tool:", result: "Result:", now: "Now:" });
    screenReader(true);
    const todo = toolUse("todo_write", {}, "t");
    const out = { content: "[x] read\n[>] fix\n[ ] test", isError: false } as never;
    expect(todoLines(todo, out)).toEqual(["Done: read", "Now: fix", "To do: test"]);
    screenReader(false);
    expect(todoLines(todo, out)).toEqual(["✔ read", "▶ fix", "○ test"]);
  });

  it("reads a choice's position and selection as words", () => {
    expect(choiceText("Allow once", 0, 3, true, marks(false))).toBe("❯ 1. Allow once");
    expect(choiceText("Deny", 2, 3, false, marks(false))).toBe("  3. Deny");
    expect(choiceText("Allow once", 0, 3, true, marks(true))).toBe(
      "Choice 1 of 3: Allow once (selected)",
    );
    expect(choiceText("Deny", 2, 3, false, marks(true))).toBe("Choice 3 of 3: Deny");
  });

  it("the footer has no symbols", () => {
    expect(sandboxText("sandbox seatbelt", false)).toBe("⛨ seatbelt");
    expect(sandboxText("sandbox seatbelt", true)).toBe("sandbox seatbelt");
    expect(contextText(4, false)).toBe("▓░░░░░░░░░ 4%");
    expect(contextText(4, true)).toBe("context 4%");
  });

  it("in the chat: a question, its answer and the footer in words", async () => {
    screenReader(true);
    const store = new ChatStore(
      { model: "m", sandbox: "sandbox seatbelt", contextPercent: 4 },
      { paint: noColor, keyHints: false, approvalKeyDelayMs: 0 },
    );
    const ui = render(<App store={store} />);
    const request: ApprovalRequest = {
      tool: "bash",
      target: { kind: "command", command: "ls", outsideSandbox: false },
      preview: "ls",
      isolation: "os",
    };
    const answer = store.ask(request, new AbortController().signal);
    await wait(30);
    const asked = ui.lastFrame() ?? "";
    expect(asked).toContain("Choice 1 of 3:");
    expect(asked).toContain("(selected)");
    expect(asked).not.toContain("❯");
    expect(asked).toContain("m · sandbox seatbelt · context 4%");
    expect(asked).not.toMatch(/[⛨▓░]/);
    store.choose();
    await answer;
    await wait(30);
    expect(ui.frames.join("\n")).toMatch(/Allowed: /);
    ui.unmount();
  });

  it("-p prints the tool lines with words", () => {
    screenReader(true);
    const err: string[] = [];
    const sink = { write: (t: string) => err.push(t) };
    const renderer = new PlainRenderer({ out: sink as never, err: sink as never }, false);
    renderer.event({ type: "tool_call", call: toolUse("bash", { command: "ls" }, "b") } as never);
    expect(err.join("")).toMatch(/^Tool: bash /m);
    expect(err.join("")).not.toContain("●");
  });
});
