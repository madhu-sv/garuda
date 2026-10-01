import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolUseBlock } from "../src/model/types.js";
import { defaultTools } from "../src/tools/index.js";
import { LIMITS } from "../src/tools/limits.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { toolContext } from "./helpers.js";
import { makeSampleRepo } from "./sampleRepo.js";

const repo = makeSampleRepo();
afterAll(repo.cleanup);

const registry = new ToolRegistry(defaultTools());
const context = toolContext(repo.root);
let id = 0;

function call(name: string, input: unknown) {
  const block: ToolUseBlock = { type: "tool_use", id: `t${id++}`, name, input };
  return registry.execute(block, context);
}

describe("tool registry", () => {
  it("ships eight tools by default (code index off), all with JSON schemas", () => {
    const specs = registry.specs();
    expect(specs.map((s) => s.name)).toEqual([
      "bash",
      "edit_file",
      "glob",
      "grep",
      "process_manager",
      "read_file",
      "remember",
      "write_file",
    ]);
    for (const spec of specs) expect(spec.inputSchema).toMatchObject({ type: "object" });
    const readOnly = defaultTools({ codeIndex: "all" }).filter((t) => t.readOnly);
    expect(readOnly.map((t) => t.name).sort()).toEqual([
      "find_references",
      "find_symbol",
      "glob",
      "grep",
      "process_manager",
      "read_file",
      "repo_map",
    ]);
  });
});

describe("read_file (F9)", () => {
  it("returns numbered lines", async () => {
    const r = await call("read_file", { path: "src/main.ts" });
    expect(r.isError).toBe(false);
    expect(r.content).toBe(
      '     1\timport { parseConfig } from "./config.js";\n     2\t\n     3\tparseConfig("app.json");',
    );
  });

  it("supports offset and limit and says how to read more", async () => {
    const r = await call("read_file", { path: "src/config.ts", offset: 3, limit: 2 });
    expect(r.content).toContain("     3\texport interface Config {");
    expect(r.content).toContain("     4\t  name: string;");
    expect(r.content).not.toContain("     5\t");
    expect(r.content).toContain("[Lines 3–4 of 9. Use offset 5 to read more.]");
  });

  it("cuts very long lines", async () => {
    writeFileSync(join(repo.root, "long.txt"), "x".repeat(LIMITS.lineChars + 10));
    const r = await call("read_file", { path: "long.txt" });
    expect(r.content).toContain(`[line cut at ${LIMITS.lineChars} characters]`);
  });

  it("refuses folders, binary files, missing files and offsets past the end", async () => {
    expect((await call("read_file", { path: "src" })).content).toMatch(/is a folder\. Use glob/);
    expect((await call("read_file", { path: "image.png" })).content).toMatch(/binary file/);
    expect((await call("read_file", { path: "nope.ts" })).content).toMatch(/does not exist/);
    expect((await call("read_file", { path: "README.md", offset: 99 })).content).toMatch(
      /past the end/,
    );
  });

  it("refuses paths outside the root (F15)", async () => {
    const r = await call("read_file", { path: "../outside/private.txt" });
    expect(r).toMatchObject({ isError: true });
    expect(r.content).toMatch(/outside the working root/);
    expect((await call("read_file", { path: "escape/private.txt" })).content).toMatch(/outside/);
  });

  it("validates input (F16)", async () => {
    const r = await call("read_file", { path: "README.md", limit: 0 });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/invalid input for read_file/);
  });
});

describe("glob (F12)", () => {
  it("finds files, newest first, and respects .gitignore and .git", async () => {
    const r = await call("glob", { pattern: "**/*.ts" });
    expect(r.content.split("\n")).toEqual(["src/main.ts", "src/util/strings.ts", "src/config.ts"]);
  });

  it("lists dotfiles but never .git", async () => {
    const all = (await call("glob", { pattern: "**/*" })).content.split("\n");
    expect(all).toContain(".gitignore");
    expect(all.some((p) => p.startsWith(".git/"))).toBe(false);
    expect(all.some((p) => p.startsWith("node_modules/") || p.endsWith(".log"))).toBe(false);
    expect(all.some((p) => p.startsWith("escape/"))).toBe(false);
  });

  it("searches inside a sub-folder, with paths relative to the root", async () => {
    const r = await call("glob", { pattern: "*.ts", path: "src/util" });
    expect(r.content).toBe("src/util/strings.ts");
  });

  it("rejects patterns that leave the folder", async () => {
    expect((await call("glob", { pattern: "../**/*" })).content).toMatch(/may not contain/);
    expect((await call("glob", { pattern: "/etc/*" })).content).toMatch(/not an absolute path/);
    expect((await call("glob", { pattern: "*", path: ".." })).content).toMatch(/outside/);
  });

  it("says when nothing matches", async () => {
    expect((await call("glob", { pattern: "**/*.py" })).content).toBe("No files match.");
  });
});

describe("grep (F13)", () => {
  it("lists files with a match and skips ignored files", async () => {
    const r = await call("grep", { pattern: "parseConfig" });
    expect(r.content.split("\n")).toEqual(["src/config.ts", "src/main.ts"]);
  });

  it("shows matching lines in content mode", async () => {
    const r = await call("grep", { pattern: "function\\s+parseConfig", mode: "content" });
    expect(r.content).toBe("src/config.ts:7:export function parseConfig(path: string): Config {");
  });

  it("shows context lines", async () => {
    const r = await call("grep", {
      pattern: "parseConfig\\(",
      mode: "content",
      context: 1,
      glob: "src/main.ts",
    });
    expect(r.content.split("\n")).toEqual([
      "src/main.ts-2-",
      'src/main.ts:3:parseConfig("app.json");',
    ]);
  });

  it("counts matches per file", async () => {
    const r = await call("grep", { pattern: "parseConfig", mode: "count" });
    expect(r.content.split("\n")).toEqual(["src/config.ts:1", "src/main.ts:2"]);
  });

  it("supports ignoreCase, glob and a single file path", async () => {
    expect((await call("grep", { pattern: "SAMPLE", ignoreCase: true })).content).toBe("README.md");
    expect((await call("grep", { pattern: "export", glob: "src/util/**" })).content).toBe(
      "src/util/strings.ts",
    );
    expect((await call("grep", { pattern: "export", path: "src/config.ts" })).content).toBe(
      "src/config.ts",
    );
  });

  it("stops at maxResults and says so", async () => {
    const r = await call("grep", { pattern: ".", mode: "content", maxResults: 2 });
    expect(r.content.split("\n\n")[0]?.split("\n")).toHaveLength(2);
    expect(r.content).toMatch(/Reached the result limit/);
  });

  it("reports no matches and bad regular expressions", async () => {
    expect((await call("grep", { pattern: "zzz_nothing" })).content).toMatch(
      /^No matches in \d+ files\.$/,
    );
    const bad = await call("grep", { pattern: "(" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/Invalid regular expression/);
  });

  it("refuses paths outside the root (F15)", async () => {
    expect((await call("grep", { pattern: "x", path: "../outside" })).content).toMatch(/outside/);
  });
});
