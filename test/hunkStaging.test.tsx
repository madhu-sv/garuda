import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  createHunkStaging,
  discardAllHunks,
  navigateHunk,
  parseHunksFromDiff,
  stageAllRemaining,
  stageCurrentHunk,
} from "../src/cli/chat/hunkStaging.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { App, HunkStagingView } from "../src/cli/chat/ui.js";
import type { ApprovalRequest } from "../src/permissions/types.js";

const sampleDiff = `--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@ import section
 import { foo } from "./foo.js";
+import { bar } from "./bar.js";

 export function run() {
@@ -10,3 +11,4 @@
   return 1;
+  // end comment
 }
`;

describe("hunkStaging parser and operations", () => {
  it("parses multiple hunks accurately from unified diff text", () => {
    const { file, hunks } = parseHunksFromDiff(sampleDiff);
    expect(file).toBe("src/app.ts");
    expect(hunks).toHaveLength(2);

    expect(hunks[0]).toMatchObject({
      id: 0,
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 5,
      staged: true,
    });
    expect(hunks[0]?.lines).toContain('+import { bar } from "./bar.js";');

    expect(hunks[1]).toMatchObject({
      id: 1,
      oldStart: 10,
      oldLines: 3,
      newStart: 11,
      newLines: 4,
      staged: true,
    });
    expect(hunks[1]?.lines).toContain("+  // end comment");
  });

  it("manages hunk staging transitions and navigation", () => {
    const staging = createHunkStaging(sampleDiff);
    if (!staging) throw new Error("Expected staging to be defined");
    expect(staging.currentHunk).toBe(0);

    // Stage first hunk -> advances to hunk 1
    const r1 = stageCurrentHunk(staging, true);
    expect(r1.finished).toBe(false);
    expect(staging.currentHunk).toBe(1);

    // Skip second hunk -> finishes review with hasStaged true
    const r2 = stageCurrentHunk(staging, false);
    expect(r2.finished).toBe(true);
    expect(r2.hasStaged).toBe(true);
    expect(staging.hunks[0]?.staged).toBe(true);
    expect(staging.hunks[1]?.staged).toBe(false);

    // Navigation
    navigateHunk(staging, -1);
    expect(staging.currentHunk).toBe(0);

    // Discard all
    discardAllHunks(staging);
    expect(staging.hunks.every((h) => !h.staged)).toBe(true);

    // Stage all
    stageAllRemaining(staging);
    expect(staging.hunks.every((h) => h.staged)).toBe(true);
  });
});

describe("Ink HunkStagingView and ChatStore integration", () => {
  const newStore = () => new ChatStore({ model: "fake", sandbox: "host" }, { paint: noColor });

  /** Hunk selections that the store passed back (U0). */
  let selected: (readonly number[])[] = [];
  const sampleRequest: ApprovalRequest = {
    tool: "edit_file",
    target: { kind: "path", path: "src/app.ts" },
    preview: sampleDiff,
    isolation: "none",
    selectHunks: (hunks) => {
      selected.push(hunks);
    },
  };

  it("renders HunkStagingView with hunk info and colored lines", () => {
    const staging = createHunkStaging(sampleDiff);
    if (!staging) throw new Error("Expected staging to be defined");
    const ui = render(<HunkStagingView staging={staging} />);
    const frame = ui.lastFrame() ?? "";

    expect(frame).toContain("Hunk 1 of 2 · src/app.ts");
    expect(frame).toContain("[2/2 staged]");
    expect(frame).toContain('+import { bar } from "./bar.js";');
    expect(frame).toContain("[y] stage hunk · [n] skip");
  });

  const until = async (check: () => boolean) => {
    const end = Date.now() + 4_000;
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out waiting for UI frame");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("enters hunk review from approval prompt via 'h' key and approves with 'a'", async () => {
    const store = newStore();
    const answer = store.ask(sampleRequest, new AbortController().signal);

    const ui = render(<App store={store} />);
    await until(() => (ui.lastFrame() ?? "").includes("h = stage hunks"));

    // Press 'h' to start hunk review
    ui.stdin.write("h");
    await until(() => (ui.lastFrame() ?? "").includes("Hunk 1 of 2 · src/app.ts"));

    // Press 'a' to stage all and approve
    ui.stdin.write("a");
    expect(await answer).toBe("once");
    expect(store.getState().approval).toBeUndefined();
  });

  it("steps through hunks with 'y' and approves on final hunk", async () => {
    const store = newStore();
    const answer = store.ask(sampleRequest, new AbortController().signal);

    const ui = render(<App store={store} />);
    await until(() => (ui.lastFrame() ?? "").includes("h = stage hunks"));
    ui.stdin.write("h");
    await until(() => (ui.lastFrame() ?? "").includes("Hunk 1 of 2"));

    // Accept hunk 1
    ui.stdin.write("y");
    await until(() => (ui.lastFrame() ?? "").includes("Hunk 2 of 2"));

    // Accept hunk 2
    selected = [];
    ui.stdin.write("y");
    expect(await answer).toBe("once");
    expect(store.getState().approval).toBeUndefined();
    // All hunks accepted: the whole change, no selection.
    expect(selected).toEqual([]);
  });

  it("accepts some hunks: 'n' then 'y' answers once and passes only hunk 2 (U0)", async () => {
    selected = [];
    const store = newStore();
    const answer = store.ask(sampleRequest, new AbortController().signal);
    const ui = render(<App store={store} />);
    await until(() => (ui.lastFrame() ?? "").includes("h = stage hunks"));
    ui.stdin.write("h");
    await until(() => (ui.lastFrame() ?? "").includes("Hunk 1 of 2"));
    ui.stdin.write("n");
    await until(() => (ui.lastFrame() ?? "").includes("Hunk 2 of 2"));
    ui.stdin.write("y");
    expect(await answer).toBe("once");
    expect(selected).toEqual([[1]]);
  });

  it("offers no hunk review when the tool cannot apply single hunks", async () => {
    const store = newStore();
    const { selectHunks: _, ...plain } = sampleRequest;
    store.ask(plain, new AbortController().signal);
    const ui = render(<App store={store} />);
    await until(() => (ui.lastFrame() ?? "").includes("1. Yes, once"));
    expect(ui.lastFrame()).not.toContain("h = stage hunks");
    expect(store.startHunkReview()).toBe(false);
  });

  it("discards all hunks with 'd' and denies", async () => {
    const store = newStore();
    const answer = store.ask(sampleRequest, new AbortController().signal);

    const ui = render(<App store={store} />);
    await until(() => (ui.lastFrame() ?? "").includes("h = stage hunks"));
    ui.stdin.write("h");
    await until(() => (ui.lastFrame() ?? "").includes("Hunk 1 of 2"));

    // Discard all with 'd'
    ui.stdin.write("d");
    expect(await answer).toBe("deny");
    expect(store.getState().approval).toBeUndefined();
  });

  it("allows exiting hunk review back to standard choices via Esc or 'q'", async () => {
    const store = newStore();
    store.ask(sampleRequest, new AbortController().signal);

    const ui = render(<App store={store} />);
    await until(() => (ui.lastFrame() ?? "").includes("h = stage hunks"));
    ui.stdin.write("h");
    await until(() => (ui.lastFrame() ?? "").includes("Hunk 1 of 2"));

    // Press 'q' to go back
    ui.stdin.write("q");
    await until(() => (ui.lastFrame() ?? "").includes("1. Yes, once"));
    expect(ui.lastFrame()).not.toContain("Hunk 1 of 2");
  });
});
