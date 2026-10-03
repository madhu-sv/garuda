import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { detectFormatters, formatCommand, formatterFor } from "../src/format/formatters.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import { findOsSandbox } from "../src/sandbox/index.js";
import { FileTracker } from "../src/session/fileTracker.js";
import { FileSessionStore } from "../src/session/store.js";
import { afterWrite, type ToolContext } from "../src/tools/types.js";

/** Formatters after edits (0.10). */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-format-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
function project(files: Record<string, string>): string {
  const root = join(base, `p${n++}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("formatter detection (0.10)", () => {
  it("finds Biome before Prettier, with their config and a local binary", () => {
    const root = project({
      "biome.json": "{}",
      ".prettierrc": "{}",
      "node_modules/.bin/biome": "",
      "node_modules/.bin/prettier": "",
    });
    const found = detectFormatters(root, "");
    expect(found.map((f) => f.name)).toEqual(["biome", "prettier"]);
    expect(formatterFor(found, "src/a.ts")?.name).toBe("biome");
    expect(formatterFor(found, "README.md")?.name).toBe("prettier");
    expect(formatterFor(found, "Makefile")).toBeUndefined();
    // A binary without config, or a config without binary: nothing.
    expect(detectFormatters(project({ "node_modules/.bin/prettier": "" }), "")).toEqual([]);
    expect(detectFormatters(project({ "biome.json": "{}" }), "")).toEqual([]);
    expect(
      detectFormatters(
        project({ "package.json": '{"prettier":{}}', "node_modules/.bin/prettier": "" }),
        "",
      )[0]?.name,
    ).toBe("prettier");
  });

  it("finds ruff, black, gofmt and rustfmt on PATH or in a venv; never runs anything", () => {
    const bin = project({ "bin/ruff": "", "bin/gofmt": "", "bin/rustfmt": "" });
    const path = join(bin, "bin");
    const py = project({ "pyproject.toml": "[tool.ruff]\nline-length = 100\n" });
    expect(detectFormatters(py, path).map((f) => f.command.slice(1))).toEqual([
      ["format", "$FILE"],
    ]);
    const venv = project({ "pyproject.toml": "[tool.black]\n", ".venv/bin/black": "" });
    expect(detectFormatters(venv, "")[0]?.command).toEqual([
      join(venv, ".venv/bin/black"),
      "-q",
      "$FILE",
    ]);
    expect(detectFormatters(project({ "go.mod": "module x\n" }), path)[0]?.name).toBe("gofmt");
    const rust = detectFormatters(project({ "Cargo.toml": 'edition = "2024"\n' }), path)[0];
    expect(rust?.command.slice(1)).toEqual(["--edition", "2024", "$FILE"]);
    expect(detectFormatters(project({ "go.mod": "" }), "")).toEqual([]);
  });

  it("settings turn a formatter off, replace one, or add one; commands are quoted", () => {
    const root = project({ "biome.json": "{}", "node_modules/.bin/biome": "" });
    expect(detectFormatters(root, "", { biome: false })).toEqual([]);
    const custom = detectFormatters(root, "", {
      mine: { extensions: [".TXT"], command: ["fmt tool", "--in", "$FILE"] },
    });
    expect(custom.map((f) => f.name)).toEqual(["mine", "biome"]);
    expect(formatterFor(custom, "/a/b.txt")?.name).toBe("mine");
    expect(formatCommand(custom[0] as never, "/p/it's here.txt")).toBe(
      "'fmt tool' --in '/p/it'\\''s here.txt'",
    );
    expect(() =>
      parseSettings({ formatters: { enabled: true, commands: { Bad: false } } }),
    ).toThrow();
    expect(parseSettings({ formatters: { enabled: true } }).formatters).toEqual({
      enabled: true,
      commands: {},
    });
  });
});

describe("the format step after an edit (0.10)", () => {
  const context = (format: ToolContext["format"]) =>
    ({ files: new FileTracker(), signal: new AbortController().signal, format }) as ToolContext;

  it("shows the formatter's diff and records the new text; a failure is a note, not an error", async () => {
    const changed = context(async () => ({ name: "prettier", text: "const a = 1;\n" }));
    const out = await afterWrite("Edited a.ts.", changed, {
      absolute: "/r/a.ts",
      shown: "a.ts",
      text: "const a=1\n",
    });
    expect(out).toMatch(/^Edited a\.ts\.\nFormatted with prettier:\n/);
    expect(out).toContain("-const a=1");
    expect(out).toContain("+const a = 1;");
    expect(changed.files.status("/r/a.ts", "const a = 1;\n")).toBe("current");

    const same = await afterWrite(
      "Edited a.ts.",
      context(async () => ({ name: "prettier", text: "x\n" })),
      {
        absolute: "/r/a.ts",
        shown: "a.ts",
        text: "x\n",
      },
    );
    expect(same).toBe("Edited a.ts.");
    const failed = await afterWrite(
      "Edited a.ts.",
      context(async () => ({ name: "ruff", problem: "exit code 2: bad syntax" })),
      { absolute: "/r/a.py", shown: "a.py", text: "x\n" },
    );
    expect(failed).toBe("Edited a.ts.\nruff could not format it: exit code 2: bad syntax");
    const long = await afterWrite(
      "Edited a.ts.",
      context(async () => ({ name: "biome", text: `${"y\n".repeat(40)}` })),
      { absolute: "/r/a.ts", shown: "a.ts", text: `${"x\n".repeat(40)}` },
    );
    expect(long).toMatch(/Formatted with biome \(\d+ diff lines\): read the file again/);
  });
});

const found = findOsSandbox();
const osReady = "executor" in found;

describe.runIf(osReady)("formatters in the OS sandbox (0.10)", () => {
  it("formats the file after edit_file; off by default; the next edit works on the new text", async () => {
    const root = project({ "notes.txt": "one\n" });
    const script = join(base, "upper.mjs");
    writeFileSync(
      script,
      'import { readFileSync, writeFileSync } from "node:fs";\nconst f = process.argv[2];\nwriteFileSync(f, readFileSync(f, "utf8").toUpperCase());\n',
    );
    chmodSync(script, 0o644);
    const settings = (enabled: boolean) =>
      parseSettings({
        executor: "os",
        formatters: {
          enabled,
          commands: {
            upper: { extensions: ["txt"], command: [process.execPath, script, "$FILE"] },
          },
        },
      });
    let seen = "";
    const model = new FakeModelClient([
      reply([toolUse("read_file", { path: "notes.txt" }, "r1")], "tool_use"),
      reply(
        [
          toolUse(
            "edit_file",
            { path: "notes.txt", old_string: "one", new_string: "one two" },
            "e1",
          ),
        ],
        "tool_use",
      ),
      (request) => {
        seen = JSON.stringify(request.messages.at(-1));
        return reply(
          [
            toolUse(
              "edit_file",
              { path: "notes.txt", old_string: "ONE TWO", new_string: "ONE TWO THREE" },
              "e2",
            ),
          ],
          "tool_use",
        );
      },
      reply([text("Done.")]),
    ]);
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: async () => model,
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: settings(true),
      mcp: false,
      hooks: false,
      profiles: [],
    });
    await runtime.runTurn("edit notes", new AbortController().signal);
    expect(seen).toContain("Formatted with upper:");
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("ONE TWO THREE\n");
    expect(model.remaining).toBe(0);

    // Off (the default): the file stays as the model wrote it.
    const plain = project({ "notes.txt": "one\n" });
    const quiet = await Runtime.create({
      root: plain,
      modelId: "fake",
      model: async () =>
        new FakeModelClient([
          reply([toolUse("write_file", { path: "new.txt", content: "abc\n" }, "w1")], "tool_use"),
          reply([text("Done.")]),
        ]),
      approver: new AutoApprover("once"),
      store: new FileSessionStore(plain),
      settings: settings(false),
      mcp: false,
      hooks: false,
      profiles: [],
    });
    await quiet.runTurn("write", new AbortController().signal);
    expect(readFileSync(join(plain, "new.txt"), "utf8")).toBe("abc\n");
  });
});

describe.runIf(osReady)("formatters and the team policy (0.14.1, review)", () => {
  it("a formatter command that the policy refuses does not run, and says why", async () => {
    const root = project({ "notes.txt": "one\n" });
    const marker = join(root, "formatter-ran");
    let seen = "";
    const model = new FakeModelClient([
      reply([toolUse("write_file", { path: "new.txt", content: "abc\n" }, "w1")], "tool_use"),
      (request) => {
        seen = JSON.stringify(request.messages.at(-1));
        return reply([text("Done.")]);
      },
    ]);
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: async () => model,
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({
        executor: "os",
        formatters: {
          enabled: true,
          commands: { touchy: { extensions: ["txt"], command: ["touch", marker, "$FILE"] } },
        },
      }),
      policy: { disallowedCommands: ["touch *"] },
      mcp: false,
      hooks: false,
      profiles: [],
    });
    await runtime.runTurn("write", new AbortController().signal);
    expect(existsSync(marker)).toBe(false);
    expect(seen).toMatch(/touchy/);
    expect(seen).toMatch(/polic/i);
  });
});

describe("the formatter A/B in evals (0.10)", () => {
  it("writes biome.json and formats the whole project once", async () => {
    const { formatProject } = await import("../src/evals/runner.js");
    const { createRequire } = await import("node:module");
    const pkg = createRequire(import.meta.url).resolve("@biomejs/biome/package.json");
    const root = project({ "src/a.js": "export const a=  {x:1}\n" });
    await formatProject(root, join(dirname(pkg), "bin", "biome"));
    expect(JSON.parse(readFileSync(join(root, "biome.json"), "utf8")).formatter.indentStyle).toBe(
      "space",
    );
    expect(readFileSync(join(root, "src/a.js"), "utf8")).toBe("export const a = { x: 1 };\n");
  }, 30_000);
});
