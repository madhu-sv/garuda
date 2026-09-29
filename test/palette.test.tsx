import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { paletteEntries } from "../src/cli/chat/commands.js";
import { filterPalette, type PaletteEntry, paletteWindow } from "../src/cli/chat/palette.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { App, onKey } from "../src/cli/chat/ui.js";
import { BUILTIN_COMMANDS } from "../src/commands/builtins.js";
import { FakeModelClient } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import { FileSessionStore } from "../src/session/store.js";

/** The command palette (0.9, Ctrl-P). */

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

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-palette-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ENTRIES: PaletteEntry[] = [
  { name: "help", hint: "show this help", runs: true },
  { name: "usage", hint: "tokens and cost of this session", runs: true },
  { name: "models", hint: "the models; /models <n|id> switches", runs: false },
  { name: "export", hint: "write this conversation as Markdown", runs: false },
  { name: "thinking", hint: "Claude's thinking", runs: false },
];

function storeWith(entries: PaletteEntry[] = ENTRIES): ChatStore {
  const store = new ChatStore({ model: "m", sandbox: "s" }, { paint: (_s, t) => t });
  store.paletteSource = () => entries;
  return store;
}

describe("the command palette (0.9)", () => {
  it("lists every built-in command with its help, then custom commands and skills", async () => {
    const root = join(base, "p");
    const runtime = await Runtime.create({
      root,
      modelId: "claude-sonnet-5",
      model: async () => new FakeModelClient([]),
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      profiles: [],
    });
    const entries = paletteEntries(runtime);
    const names = entries.map((e) => e.name);
    // Every built-in but the "quit" alias is in the help, so in the palette.
    expect([...names].sort()).toEqual(BUILTIN_COMMANDS.filter((c) => c !== "quit").sort());
    expect(entries.find((e) => e.name === "usage")).toEqual({
      name: "usage",
      hint: "tokens and cost of this session",
      runs: true,
    });
    expect(entries.find((e) => e.name === "where")).toMatchObject({
      hint: "where symbol X is defined (code index, no model call)",
      runs: false,
    });
    expect(entries.find((e) => e.name === "models")?.runs).toBe(false);
    expect(entries.find((e) => e.name === "details")?.runs).toBe(true);
  });

  it("filters by name (letters in order), then by help text", () => {
    expect(filterPalette(ENTRIES, "")).toEqual(ENTRIES);
    expect(filterPalette(ENTRIES, "/mod").map((e) => e.name)).toEqual(["models"]);
    expect(filterPalette(ENTRIES, "thk").map((e) => e.name)).toEqual(["thinking"]);
    expect(filterPalette(ENTRIES, "markdown").map((e) => e.name)).toEqual(["export"]);
    expect(filterPalette(ENTRIES, "zzz")).toEqual([]);
    expect(paletteWindow(0, 30)).toBe(0);
    expect(paletteWindow(15, 30)).toBe(6);
    expect(paletteWindow(29, 30)).toBe(20);
  });

  it("Ctrl-P opens it; Enter runs a command with no arguments", async () => {
    const store = storeWith();
    press(store, "p", { ctrl: true });
    expect(store.getState().palette?.entries).toHaveLength(5);
    type(store, "usg");
    expect(store.getState().palette?.entries.map((e) => e.name)).toEqual(["usage"]);
    const next = store.nextInput();
    press(store, "", { return: true });
    expect(await next).toBe("/usage");
    expect(store.getState().palette).toBeUndefined();
  });

  it("Enter puts a command with arguments in the line; Backspace, arrows and Esc work", () => {
    const store = storeWith();
    press(store, "p", { ctrl: true });
    type(store, "xx");
    expect(store.getState().palette?.entries).toEqual([]);
    press(store, "", { backspace: true });
    press(store, "", { backspace: true });
    press(store, "", { downArrow: true });
    press(store, "", { downArrow: true });
    press(store, "", { return: true });
    expect(store.getState().editor.text).toBe("/models ");
    expect(store.getState().editor.cursor).toBe(8);

    press(store, "p", { ctrl: true });
    press(store, "", { upArrow: true });
    expect(store.getState().palette?.selected).toBe(4);
    press(store, "", { escape: true });
    expect(store.getState().palette).toBeUndefined();
    expect(store.getState().editor.text).toBe("/models ");
    press(store, "p", { ctrl: true });
    press(store, "p", { ctrl: true });
    expect(store.getState().palette).toBeUndefined();
  });

  it("draws the rows in place of the input line", async () => {
    const store = storeWith();
    const ui = render(<App store={store} />);
    press(store, "p", { ctrl: true });
    type(store, "exp");
    await new Promise((r) => setTimeout(r, 50));
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Command › exp");
    expect(frame).toContain("❯ /export");
    expect(frame).toContain("write this conversation as Markdown");
    expect(frame).toContain("Esc closes");
    ui.unmount();
  });
});
