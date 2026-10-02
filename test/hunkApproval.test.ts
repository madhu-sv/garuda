import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseHunksFromDiff } from "../src/cli/chat/hunkStaging.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { toolUse } from "../src/model/fake.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { FileTracker } from "../src/session/fileTracker.js";
import { applyHunks, previewIsComplete, unifiedDiff } from "../src/tools/diff.js";
import { editFileTool } from "../src/tools/editFile.js";
import { readFileTool } from "../src/tools/readFile.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/types.js";

/**
 * U0 (merge gate): hunk-by-hunk approval constrains what reaches the disk. These tests check the
 * FILE, not the answer: the M0 handoff reproduced a rejected hunk that was still written.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-hunks-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;

/** 20 lines; "alpha" on line 2 and "omega" on line 19, far apart: two hunks. */
const ORIGINAL = `${Array.from({ length: 20 }, (_, i) =>
  i === 1 ? "alpha" : i === 18 ? "omega" : `line ${i + 1}`,
).join("\n")}\n`;

async function setup() {
  const root = join(base, `r${n++}`);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(root, { recursive: true });
  const file = join(root, "f.txt");
  writeFileSync(file, ORIGINAL);
  const store = new ChatStore({ model: "fake", sandbox: "host" }, { paint: noColor });
  const permissions = new PermissionEngine({ root, approver: store });
  const tools = new ToolRegistry([readFileTool, editFileTool]);
  const context: ToolContext = {
    root,
    signal: new AbortController().signal,
    permissions,
    files: new FileTracker(),
  };
  await tools.execute(toolUse("read_file", { path: "f.txt" }), context);
  return { root, file, store, tools, context };
}

/** Wait until the store shows an approval. */
async function approvalShown(store: ChatStore): Promise<void> {
  const end = Date.now() + 4_000;
  while (store.getState().approval === undefined) {
    if (Date.now() > end) throw new Error("no approval");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Edit both lines in one edit_file call (old_string spans the file), answering hunks as given. */
async function editWith(answers: ("y" | "n")[]) {
  const { file, store, tools, context } = await setup();
  const call = toolUse("edit_file", {
    path: "f.txt",
    old_string: ORIGINAL,
    new_string: ORIGINAL.replace("alpha", "ALPHA").replace("omega", "OMEGA"),
  });
  const done = tools.execute(call, context);
  await approvalShown(store);
  expect(store.startHunkReview()).toBe(true);
  expect(store.getState().approval?.hunkReview?.hunks).toHaveLength(2);
  for (const a of answers) store.stageHunk(a === "y");
  const outcome = await done;
  return { outcome, text: readFileSync(file, "utf8") };
}

describe("hunk approval writes only the accepted hunks (U0)", () => {
  it("n then y: alpha stays, only omega changes (the M0 reproduction)", async () => {
    const { outcome, text } = await editWith(["n", "y"]);
    expect(outcome.isError).toBe(false);
    expect(text).toContain("\nalpha\n");
    expect(text).toContain("\nOMEGA\n");
    expect(outcome.content).toMatch(/accepted 1 of 2 hunk\(s\) and rejected hunk\(s\) 1/);
  });

  it("y then n: only alpha changes", async () => {
    const { text } = await editWith(["y", "n"]);
    expect(text).toContain("\nALPHA\n");
    expect(text).toContain("\nomega\n");
  });

  it("y then y: the whole edit", async () => {
    const { outcome, text } = await editWith(["y", "y"]);
    expect(text).toContain("\nALPHA\n");
    expect(text).toContain("\nOMEGA\n");
    expect(outcome.content).not.toMatch(/accepted/);
  });

  it("n then n: nothing is written and the model is told it was denied", async () => {
    const { outcome, text } = await editWith(["n", "n"]);
    expect(text).toBe(ORIGINAL);
    expect(outcome).toMatchObject({ isError: true, denied: true });
  });

  it("a file that changed while the user reviewed: nothing is written", async () => {
    const { file, store, tools, context } = await setup();
    const done = tools.execute(
      toolUse("edit_file", {
        path: "f.txt",
        old_string: "alpha",
        new_string: "ALPHA",
      }),
      context,
    );
    await approvalShown(store);
    // Someone else changes the file (the tracker sees the edit as "changed after the last read").
    writeFileSync(file, ORIGINAL.replace("line 10", "LINE TEN"));
    store.startHunkReview();
    store.stageHunk(true);
    const outcome = await done;
    expect(outcome.isError).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("LINE TEN");
    expect(readFileSync(file, "utf8")).toContain("\nalpha\n");
  });
});

describe("hunk helpers (U0)", () => {
  it("applies a subset of hunks and refuses an index that does not exist", () => {
    const after = ORIGINAL.replace("alpha", "ALPHA").replace("omega", "OMEGA");
    expect(applyHunks(ORIGINAL, after, [1])).toBe(ORIGINAL.replace("omega", "OMEGA"));
    expect(applyHunks(ORIGINAL, after, [0, 1])).toBe(after);
    expect(applyHunks(ORIGINAL, after, [])).toBe(ORIGINAL);
    expect(() => applyHunks(ORIGINAL, after, [2])).toThrow(/no hunk 3/);
  });

  it("a cut preview offers no hunk review", () => {
    const big = `${Array.from({ length: 2000 }, (_, i) => `l${i}`).join("\n")}\n`;
    const changed = big.replace(/^l(\d+)$/gm, "L$1");
    expect(previewIsComplete(unifiedDiff("f", big, changed))).toBe(false);
    expect(previewIsComplete(unifiedDiff("f", "a\n", "b\n"))).toBe(true);
  });

  it("keeps a removed line that starts with '-- ' (an SQL comment) inside a hunk", () => {
    const diff = unifiedDiff("q.sql", "select 1;\n-- old note\n", "select 1;\n");
    const { hunks } = parseHunksFromDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines).toContain("--- old note");
  });
});
