import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { banner, centerBlock, centerLines, visibleWidth } from "../src/cli/banner.js";
import { clearScreenKeepingScrollback } from "../src/cli/chat/inkChat.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { App, INPUT_HINT, INPUT_HINT_BUSY } from "../src/cli/chat/ui.js";
import { parseSettings } from "../src/permissions/settings.js";

/** 0.18.1: a clean start, a centred banner and a visible chat box. */

const info = {
  version: "0.18.1",
  model: "claude-sonnet-5",
  sandbox: "seatbelt · no network",
  root: "/Users/m/dev/garuda",
  extras: [],
  ink: true,
};

describe("the centred banner", () => {
  it("centres the wordmark and the card as blocks, so their lines stay aligned", () => {
    const out = banner(info, { columns: 100, color: "none", home: "/Users/m", center: true });
    const rows = out.split("\n");
    const card = rows.filter((l) => /^\s*[╭│╰]/.test(l));
    const lead = (l: string) => l.length - l.trimStart().length;
    expect(new Set(card.map(lead)).size).toBe(1);
    const width = visibleWidth(card[0]?.trimStart() ?? "");
    expect(lead(card[0] ?? "")).toBe(Math.floor((100 - width) / 2));
    // The wordmark's rows share one indent (its own first row starts with a space).
    const mark = rows.slice(0, 5);
    expect([lead(mark[2] ?? ""), lead(mark[3] ?? "")]).toEqual([
      lead(mark[1] ?? ""),
      lead(mark[1] ?? ""),
    ]);
    expect(lead(mark[0] ?? "")).toBe(lead(mark[1] ?? "") + 1);
    // The negative control: without `center`, nothing moves.
    expect(banner(info, { columns: 100, color: "none", home: "/Users/m" }).split("\n")[0]).toBe(
      " ██████   █████  ██████  ██    ██ ██████   █████ ",
    );
  });

  it("measures lines without escape codes, and never pads a line wider than the screen", () => {
    expect(visibleWidth("\u001b[2mabc\u001b[22m")).toBe(3);
    expect(centerLines(["ab", ""], 10)).toEqual(["    ab", ""]);
    expect(centerLines(["x".repeat(20)], 10)).toEqual(["x".repeat(20)]);
    expect(centerBlock(["a", "bbb"], 3, 9)).toEqual(["   a", "   bbb"]);
  });
});

describe("the clean start", () => {
  it("pushes the old screen into the scrollback, then goes to the top", () => {
    expect(clearScreenKeepingScrollback(3)).toBe("\n\n\n\u001b[H");
    expect(clearScreenKeepingScrollback(0)).toBe("\n\u001b[H");
  });

  it('"ui": { "clearOnStart": false } turns it off; the default is on', () => {
    expect(parseSettings({ ui: { clearOnStart: false } }).ui).toEqual({ clearOnStart: false });
    expect(parseSettings({}).ui).toBeUndefined();
    expect(() => parseSettings({ ui: { other: true } })).toThrow();
  });
});

describe("the chat box", () => {
  const frameOf = async (store: ChatStore) => {
    const ui = render(<App store={store} />);
    await new Promise((r) => setTimeout(r, 30));
    const frame = ui.lastFrame() ?? "";
    ui.unmount();
    return frame;
  };
  const newStore = () =>
    new ChatStore({ model: "m", sandbox: "sandbox test" }, { paint: noColor, keyHints: false });

  it("an empty box shows the hint; while a turn runs, the busy hint", async () => {
    const store = newStore();
    const idle = await frameOf(store);
    expect(idle).toMatch(/╭─+╮\n│ › {2}Type a task · \/ for commands · @ for files +│\n╰─+╯/);
    store.begin("go");
    const busy = await frameOf(store);
    expect(busy).toContain(INPUT_HINT_BUSY);
    expect(busy).not.toContain(INPUT_HINT);
  });

  it("typed text replaces the hint", async () => {
    const store = newStore();
    store.editLine({ type: "insert", text: "fix the bug" });
    const frame = await frameOf(store);
    expect(frame).toContain("│ › fix the bug");
    expect(frame).not.toContain(INPUT_HINT);
  });

  it("a screen reader gets the input line with no box", async () => {
    const before = process.env.GARUDA_SCREEN_READER;
    process.env.GARUDA_SCREEN_READER = "1";
    try {
      const frame = await frameOf(newStore());
      expect(frame).toContain(`›  ${INPUT_HINT}`);
      expect(frame).not.toMatch(/[╭╰]/);
    } finally {
      if (before === undefined) delete process.env.GARUDA_SCREEN_READER;
      else process.env.GARUDA_SCREEN_READER = before;
    }
  });
});
