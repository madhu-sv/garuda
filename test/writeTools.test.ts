import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolUseBlock } from "../src/model/types.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { FileTracker } from "../src/session/fileTracker.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { toolContext } from "./helpers.js";
import { makeSampleRepo } from "./sampleRepo.js";

const repo = makeSampleRepo();
afterAll(repo.cleanup);

const registry = new ToolRegistry(defaultTools());
let id = 0;

/** A fresh session context: new read tracking, an approver that records requests. */
function session(answer: "once" | "deny" = "once") {
  const approver = new AutoApprover(answer);
  const context = toolContext(repo.root, {
    permissions: new PermissionEngine({ root: repo.root, approver }),
    files: new FileTracker(),
    executor: new HostExecutor(),
  });
  const call = (name: string, input: unknown) => {
    const block: ToolUseBlock = { type: "tool_use", id: `w${id++}`, name, input };
    return registry.execute(block, context);
  };
  return { approver, call };
}

const read = (path: string) => readFileSync(join(repo.root, path), "utf8");

describe("write_file (F10)", () => {
  it("creates a new file and its folders, after approval with a diff", async () => {
    const { approver, call } = session();
    const r = await call("write_file", { path: "new/dir/hello.ts", content: "a\nb\n" });
    expect(r).toEqual({ content: "Created new/dir/hello.ts (2 lines).", isError: false });
    expect(read("new/dir/hello.ts")).toBe("a\nb\n");
    expect(approver.requests).toHaveLength(1);
    expect(approver.requests[0]?.preview).toContain("+++ b/new/dir/hello.ts");
    expect(approver.requests[0]?.preview).toContain("+a");
  });

  it("fails when the file exists", async () => {
    const { call } = session();
    const r = await call("write_file", { path: "README.md", content: "x" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/already exists\. Read it, then use edit_file/);
    expect(read("README.md")).toContain("# Sample");
  });

  it("does not write when the user denies", async () => {
    const { call } = session("deny");
    const r = await call("write_file", { path: "denied.ts", content: "x" });
    expect(r.content).toMatch(/^Permission denied: The user denied this call/);
    expect(() => read("denied.ts")).toThrow();
  });

  it("refuses paths outside the root and sensitive paths, with no question", async () => {
    const { approver, call } = session();
    expect((await call("write_file", { path: "../x.ts", content: "" })).content).toMatch(
      /outside the working root/,
    );
    expect((await call("write_file", { path: ".env", content: "K=1" })).content).toMatch(
      /sensitive file/,
    );
    expect(approver.requests).toEqual([]);
  });
});

describe("edit_file (F11)", () => {
  it("replaces one exact string after a read, and shows the diff", async () => {
    const { approver, call } = session();
    await call("read_file", { path: "src/main.ts" });
    const r = await call("edit_file", {
      path: "src/main.ts",
      old_string: 'parseConfig("app.json")',
      new_string: 'parseConfig("config.json")',
    });
    expect(r).toEqual({ content: "Edited src/main.ts.", isError: false });
    expect(read("src/main.ts")).toContain('parseConfig("config.json");');
    expect(approver.requests[0]?.preview).toContain('-parseConfig("app.json");');
    expect(approver.requests[0]?.preview).toContain('+parseConfig("config.json");');
  });

  it("allows a second edit with no new read, because the tool knows its own write", async () => {
    const { call } = session();
    await call("read_file", { path: "src/util/strings.ts" });
    const edit = (from: string, to: string) =>
      call("edit_file", { path: "src/util/strings.ts", old_string: from, new_string: to });
    expect((await edit("shout", "yell")).isError).toBe(false);
    expect((await edit("toUpperCase", "toLocaleUpperCase")).isError).toBe(false);
    expect(read("src/util/strings.ts")).toBe(
      "export const yell = (s: string) => s.toLocaleUpperCase();\n",
    );
  });

  it("fails when the file was not read in this session", async () => {
    const { approver, call } = session();
    const r = await call("edit_file", { path: "README.md", old_string: "Sample", new_string: "X" });
    expect(r.content).toMatch(/Read README\.md with read_file before you edit it/);
    expect(approver.requests).toEqual([]);
  });

  it("fails when the file changed after the last read", async () => {
    const { call } = session();
    await call("read_file", { path: "README.md" });
    writeFileSync(join(repo.root, "README.md"), "# Sample\n\nChanged by someone else.\n");
    const r = await call("edit_file", { path: "README.md", old_string: "Sample", new_string: "X" });
    expect(r.content).toMatch(/changed after your last read\. Read it again/);
  });

  it("fails on zero or several matches", async () => {
    const { call } = session();
    await call("read_file", { path: "src/config.ts" });
    const none = await call("edit_file", {
      path: "src/config.ts",
      old_string: "nope",
      new_string: "x",
    });
    expect(none.content).toMatch(/old_string was not found/);
    const many = await call("edit_file", {
      path: "src/config.ts",
      old_string: "Config",
      new_string: "Settings",
    });
    expect(many.content).toMatch(/occurs 3 times/);
  });

  it("keeps $ patterns in new_string literal", async () => {
    const { call } = session();
    writeFileSync(join(repo.root, "dollar.txt"), "price = X\n");
    await call("read_file", { path: "dollar.txt" });
    await call("edit_file", { path: "dollar.txt", old_string: "X", new_string: "$& $1 $$" });
    expect(read("dollar.txt")).toBe("price = $& $1 $$\n");
  });
});

describe("bash (F14)", () => {
  it("runs in the root after approval and returns exit code, stdout and stderr", async () => {
    const { approver, call } = session();
    const r = await call("bash", { command: "ls README.md; echo oops >&2; exit 2" });
    expect(r.isError).toBe(false);
    expect(r.content).toBe(
      "Exit code: 2\n<stdout>\nREADME.md\n</stdout>\n<stderr>\noops\n</stderr>",
    );
    expect(approver.requests).toMatchObject([
      { tool: "bash", preview: "ls README.md; echo oops >&2; exit 2", isolation: "none" },
    ]);
  });

  it("reports a timeout", async () => {
    const { call } = session();
    const r = await call("bash", { command: "sleep 10", timeout_ms: 1_000 });
    expect(r.content).toMatch(/^The command timed out and was killed\./);
  });

  it("marks truncated output", async () => {
    const { call } = session();
    const r = await call("bash", { command: "seq 1 20000" });
    expect(r.content).toMatch(/<stdout \(truncated: \d+ bytes in total\)>/);
    expect(r.content).toContain("bytes cut");
  });

  it("does not run when the user denies", async () => {
    const { call } = session("deny");
    const r = await call("bash", { command: "touch ran.txt" });
    expect(r.isError).toBe(true);
    expect(() => read("ran.txt")).toThrow();
  });
});
