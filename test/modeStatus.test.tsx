import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { modeSwitchText, modeToggler, statusOf } from "../src/cli/chat/controller.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { App, footerModes, modeWord } from "../src/cli/chat/ui.js";
import { FakeModelClient } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import { FileSessionStore } from "../src/session/store.js";

/** Review 2026-11: "unclear Plan/Build status". The chat names the mode, and when a switch applies. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-mode-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("the footer's mode", () => {
  it("is always named; while a turn runs in the other mode, both, with when", () => {
    expect(footerModes({}, false)).toEqual([{ mode: "build", label: "" }]);
    expect(footerModes({ mode: "plan" }, false)).toEqual([{ mode: "plan", label: "" }]);
    expect(footerModes({ mode: "plan", turnMode: "build" }, true)).toEqual([
      { mode: "build", label: "now" },
      { mode: "plan", label: "next turn" },
    ]);
    // Idle: the last turn's mode does not matter.
    expect(footerModes({ mode: "plan", turnMode: "build" }, false)).toEqual([
      { mode: "plan", label: "" },
    ]);
    expect(modeWord("build", false)).toBe("BUILD");
    expect(modeWord("plan", true)).toBe("Plan mode");
  });

  it("the chat shows BUILD, PLAN, the plan marker in the input line, and 'now · next turn'", async () => {
    const frame = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return ui.lastFrame() ?? "";
    };
    const store = new ChatStore({ model: "m", sandbox: "s" }, { paint: noColor });
    const ui = render(<App store={store} />);
    expect(await frame()).toContain("BUILD");
    store.refreshStatus({ model: "m", sandbox: "s", mode: "plan" });
    const plan = await frame();
    expect(plan).toContain("PLAN");
    expect(plan).toContain("plan ›");
    expect(plan).not.toContain("BUILD");
    store.begin("task");
    store.refreshStatus({ model: "m", sandbox: "s", mode: "plan", turnMode: "build" });
    expect(await frame()).toContain("BUILD now · PLAN next turn");
    ui.unmount();
  });
});

describe("Shift+Tab", () => {
  it("says what the mode does, and 'from the next turn' while a turn runs in the other mode", () => {
    expect(modeSwitchText("plan")).toBe(
      "Plan mode: the agent reads and plans, and changes no files. Shift+Tab switches back.",
    );
    expect(modeSwitchText("plan", "build")).toContain(
      "From the next turn: this turn stays in build mode.",
    );
    expect(modeSwitchText("build", "build")).not.toContain("next turn");
  });

  it("the handler switches the runtime, adds the note, and gives the status with the turn's mode", async () => {
    const root = join(base, "toggle");
    mkdirSync(root, { recursive: true });
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: async () => new FakeModelClient([]),
      approver: new AutoApprover(),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      commands: false,
      profiles: [],
    });
    try {
      const store = new ChatStore(statusOf(runtime), { paint: noColor });
      store.begin("task");
      const status = modeToggler(store, runtime)();
      expect(runtime.mode).toBe("plan");
      expect(status).toMatchObject({ mode: "plan", turnMode: "build" });
      const notes = store.getState().items.filter((i) => i.kind === "note");
      expect(notes.at(-1)?.text).toContain("From the next turn: this turn stays in build mode.");
    } finally {
      await runtime.close();
    }
  });
});
