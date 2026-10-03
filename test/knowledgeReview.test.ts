/**
 * The code index findings of Garuda's own review (Fable, 2026-10; patch 0133). Each test failed
 * before the fix. Temp folders only; no real home folder.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KnowledgeIndex } from "../src/knowledge/index.js";
import { discoverPlugins } from "../src/knowledge/plugins.js";
import { braceDepthAt, importNames, pythonEnclosingLine } from "../src/knowledge/scope.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-knowledge-review-")));
afterAll(() => {
  chmodSync(base, 0o755);
  rmSync(base, { recursive: true, force: true });
});
let n = 0;
function project(files: Record<string, string>) {
  const root = join(base, `p${n++}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("TypeScript references", () => {
  it("finds the uses of a name that is also part of a keyword on its line", async () => {
    const root = project({
      "src/lib.ts":
        "export const port = 3000;\nexport function on(): number {\n  return port;\n}\n",
      "src/use.ts": 'import { on, port } from "./lib.js";\nexport const x = on() + port;\n',
    });
    const index = new KnowledgeIndex(root);
    expect((await index.findReferences("port")).references.length).toBeGreaterThan(1);
    expect((await index.findReferences("on")).references.map((r) => r.path)).toContain(
      "src/use.ts",
    );
  });
});

describe("callers: module-level code is <module>", () => {
  it("Python: by indentation; TS: by brace depth", async () => {
    const root = project({
      "app.py":
        "def target():\n    pass\n\ndef helper():\n    if True:\n        target()\n\nif __name__ == '__main__':\n    target()\n",
      "src/a.ts":
        "export function target(): void {}\nexport function helper(): void {\n  target();\n}\ntarget();\n",
    });
    const index = new KnowledgeIndex(root);
    const py = (await index.findCallers("target", "app.py")).callers;
    expect(py.map((c) => [c.callLine, c.callerName])).toEqual([
      [6, "helper"],
      [9, "<module>"],
    ]);
    const ts = (await index.findCallers("target", "src/a.ts")).callers;
    expect(ts.map((c) => [c.callLine, c.callerName])).toEqual([
      [3, "helper"],
      [5, "<module>"],
    ]);
  });

  it("the scope helpers", () => {
    const lines = ["class A:", "    def m(self):", "        x()", "", "y()"];
    expect(pythonEnclosingLine(lines, 3)).toBe(2);
    expect(pythonEnclosingLine(lines, 5)).toBeUndefined();
    const ts = 'const s = "{";\n// {\nfunction f() {\n  /* { */ g();\n}\nh();\n';
    expect(braceDepthAt(ts, 4)).toBe(1);
    expect(braceDepthAt(ts, 6)).toBe(0);
  });
});

describe("impact_analysis", () => {
  it("a file depends on the target only when its import names the target", () => {
    expect(importNames("src/app.ts", "./tools/index.js", "src/tools/index.ts")).toBe(true);
    expect(importNames("src/app.ts", "./tools", "src/tools/index.ts")).toBe(true);
    expect(importNames("src/app.ts", "../knowledge/index.js", "src/tools/index.ts")).toBe(false);
    expect(importNames("src/app.ts", "./mcp/index.js", "src/tools/index.ts")).toBe(false);
    expect(importNames("pkg/main.py", "pkg.service", "pkg/service.py")).toBe(true);
    expect(importNames("pkg/main.py", ".service", "pkg/service.py")).toBe(true);
    expect(importNames("pkg/main.py", "service_utils", "pkg/service.py")).toBe(false);
    expect(importNames("A.java", "com.x.Foo", "src/main/java/com/x/Foo.java")).toBe(true);
    expect(importNames("cmd/main.go", "example.com/app/store", "store/db.go")).toBe(true);
  });

  it("an unrelated importer of another index file is not a dependent", async () => {
    const root = project({
      "src/a/index.ts": "export const t = 1;\n",
      "src/b/index.ts": "export const u = 1;\n",
      "src/user.ts": 'import { u } from "./b/index.js";\nexport const v = u;\n',
    });
    const result = await new KnowledgeIndex(root).impactAnalysis("src/a/index.ts");
    expect(result.dependentFiles).not.toContain("src/user.ts");
  });

  it("a target that is not found has risk unknown, not low (K3)", async () => {
    const root = project({ "a.py": "def known():\n    pass\n" });
    const result = await new KnowledgeIndex(root).impactAnalysis("missingSymbol");
    expect(result.riskLevel).toBe("unknown");
  });
});

describe("parsers", () => {
  it("Python: an assigned triple-quoted string does not hide the rest of the file", async () => {
    const root = project({ "q.py": 'QUERY = """\nSELECT 1\n"""\n\ndef foo():\n    pass\n' });
    const index = new KnowledgeIndex(root);
    expect((await index.findSymbols("foo", true)).map((s) => s.line)).toEqual([5]);
    expect((await index.findSymbols("QUERY", true)).length).toBe(1);
  });

  it("Go: grouped var/const/type declarations and generic functions", async () => {
    const root = project({
      "x.go":
        'package x\n\nvar (\n\tErrNotFound = errors.New("x")\n)\n\nconst (\n\tStatusPending = iota\n\tStatusDone\n)\n\ntype (\n\tID string\n\tStack[T any] struct {\n\t\titems []T\n\t}\n)\n\nfunc Map[T any](xs []T) []T { return xs }\n',
    });
    const index = new KnowledgeIndex(root);
    for (const name of ["ErrNotFound", "StatusPending", "StatusDone", "ID", "Map"]) {
      expect((await index.findSymbols(name, true)).length, name).toBe(1);
    }
    expect(await index.findSymbols("items", true)).toEqual([]);
  });

  it("Java: no phantom class from a string or a comment; else/return lines are not methods", async () => {
    const root = project({
      "A.java":
        'public class A {\n  void run(boolean b) {\n    log.warn("class Foo is old");\n    if (b) go(); else doThing(1);\n    // the class Bar\n  }\n  int f(int x) {\n    if (x > 0) return 1;\n    else return compute(x);\n  }\n}\n',
    });
    const index = new KnowledgeIndex(root);
    expect(await index.findSymbols("Foo", true)).toEqual([]);
    expect(await index.findSymbols("Bar", true)).toEqual([]);
    expect(await index.findSymbols("doThing", true)).toEqual([]);
    expect(await index.findSymbols("compute", true)).toEqual([]);
    expect((await index.findSymbols("run", true))[0]?.container).toBe("A");
  });

  it("ast_query filters before the limit", async () => {
    const many = Array.from({ length: 300 }, (_, i) => `def f${i}():\n    pass\n`).join("");
    const root = project({ "a/many.py": many, "b/late.py": "class Late:\n    pass\n" });
    const hits = await new KnowledgeIndex(root).astQuery({ kind: "class", limit: 5 });
    expect(hits.map((h) => h.name)).toEqual(["Late"]);
  });
});

describe("robustness", () => {
  it("repo_map works on a project where the cache cannot be written", async () => {
    const root = project({ "a.py": "def a():\n    pass\n" });
    mkdirSync(join(root, ".garuda"));
    writeFileSync(join(root, ".garuda", "index"), "a file where the cache folder should be");
    const nodes = await new KnowledgeIndex(root).repoMap();
    expect(nodes.map((node) => node.path)).toEqual(["a.py"]);
  });

  it("parallel calls load the experts once", async () => {
    const root = project({ "a.py": "def a():\n    pass\n" });
    const index = new KnowledgeIndex(root);
    const [x, y] = await Promise.all([index.findSymbols("a", true), index.findSymbols("a", true)]);
    expect(x).toEqual(y);
    const experts = (index as unknown as { pluginLoading?: Promise<unknown> }).pluginLoading;
    expect(experts).toBeInstanceOf(Promise);
  });

  it("a user plugin factory runs once, with the project root", async () => {
    const root = project({});
    const home = project({
      ".garuda/languages/rec.mjs":
        "globalThis.__garudaRoots = [];\nexport default function (root) {\n  globalThis.__garudaRoots.push(root);\n  return { id: 'rec', extensions: ['.rec'], summarise: (p) => ({ path: p, exports: [], imports: [] }), findSymbols: () => [], findReferences: () => ({ references: [], candidates: [] }) };\n}\n",
    });
    const { plugins } = await discoverPlugins({ root, home, includeBuiltins: false });
    await plugins[0]?.factory(root);
    expect((globalThis as { __garudaRoots?: string[] }).__garudaRoots).toEqual([root]);
  });
});
