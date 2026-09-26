import { describe, expect, it } from "vitest";
import { banner, colorLevel, WORDMARK_MIN_COLUMNS } from "../src/cli/banner.js";

const info = {
  version: "0.2.0",
  model: "claude-haiku-4-5-20251001",
  sandbox: "seatbelt · no network",
  root: "/Users/m/dev/garuda-live",
  extras: ["1 MCP server", "2 hooks", "web_fetch"],
  ink: true,
};
const lines = (text: string) => text.split("\n");

describe("start banner", () => {
  it("shows the wordmark and a card with the session facts", () => {
    const out = banner(info, { columns: 100, color: "none", home: "/Users/m" });
    expect(lines(out)[0]).toBe(" ██████   █████  ██████  ██    ██ ██████   █████ ");
    expect(out).toContain("│ ✦ Garuda 0.2.0 · a terminal coding agent");
    expect(out).toContain("│   model    claude-haiku-4-5-20251001");
    expect(out).toContain("│   folder   ~/dev/garuda-live");
    expect(out).toContain("│   extras   1 MCP server · 2 hooks · web_fetch");
    expect(out).toContain(" /help · Esc stops a task · \\ then Enter: new line · Ctrl-G editor");
    // Every card line has the same width.
    const card = lines(out).filter((l) => /^[╭│╰]/.test(l));
    expect(new Set(card.map((l) => [...l].length)).size).toBe(1);
  });

  it("drops the wordmark on a narrow terminal and cuts long values from the start", () => {
    const out = banner(
      { ...info, root: "/very/long/path/to/some/deeply/nested/project/folder", ink: false },
      { columns: WORDMARK_MIN_COLUMNS - 1, color: "none", home: "/Users/m" },
    );
    expect(out).not.toContain("██");
    expect(out).toMatch(/folder {3}….*project\/folder/);
    expect(out).toContain(" /help · Ctrl-C stops a task · \\ at the end: new line");
    expect(out).not.toContain("Ctrl-G");
    for (const l of lines(out)) expect([...l].length).toBeLessThanOrEqual(WORDMARK_MIN_COLUMNS - 1);
  });

  it("uses a saffron-to-gold gradient on true-color terminals, and no color when asked", () => {
    const out = banner(info, { columns: 100, color: "truecolor", home: "/Users/m" });
    expect(out).toContain("\u001b[38;2;255;122;24m█");
    expect(out).toContain("\u001b[38;2;255;209;102m");
    expect(banner(info, { columns: 100, color: "none" })).not.toContain("\u001b[");
  });

  it("picks the color level from the terminal and NO_COLOR", () => {
    expect(colorLevel({ isTTY: true }, { COLORTERM: "truecolor" })).toBe("truecolor");
    expect(colorLevel({ isTTY: true }, {})).toBe("basic");
    expect(colorLevel({ isTTY: true }, { NO_COLOR: "1", COLORTERM: "truecolor" })).toBe("none");
    expect(colorLevel({ isTTY: false }, { COLORTERM: "truecolor" })).toBe("none");
  });
});
