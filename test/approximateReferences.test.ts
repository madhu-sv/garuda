import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeFiles } from "../src/evals/files.js";
import { KnowledgeIndex } from "../src/knowledge/index.js";
import { JavaExpert } from "../src/knowledge/java.js";
import { PythonExpert } from "../src/knowledge/python.js";
import {
  callersText,
  findCallersTool,
  findReferencesTool,
  referencesText,
} from "../src/tools/codeTools.js";
import { impactAnalysisText, impactAnalysisTool } from "../src/tools/impactAnalysis.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { toolContext } from "./helpers.js";
import { referenceCorpus } from "./referenceSample.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-approximate-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let serial = 0;
async function project(files: Record<string, string>) {
  const root = join(base, `p${serial++}`);
  await writeFiles(root, files);
  return root;
}

describe("approximate reference results", () => {
  for (const language of ["java", "python"] as const) {
    const sample = referenceCorpus.cases.find(
      (s) => s.id === (language === "java" ? "java-direct" : "py-direct"),
    );
    if (!sample) throw new Error(`missing ${language} fixture`);

    it(`${language}: expert and index expose the approximation; tool text keeps it`, async () => {
      const root = await project(sample.files);
      const expert = language === "java" ? new JavaExpert(root) : new PythonExpert(root);
      expect(
        expert.findReferences(Object.keys(sample.files), "total", sample.query.path, 200),
      ).toMatchObject({ approximate: true });
      const index = new KnowledgeIndex(root);
      const refs = await index.findReferences("total", sample.query.path);
      expect(refs).toMatchObject({ approximate: true });
      expect(referencesText(refs)).toMatch(/^Approximate:/);
      const registry = new ToolRegistry([findReferencesTool]);
      const outcome = await registry.execute(
        {
          type: "tool_use",
          id: "r",
          name: "find_references",
          input: { name: "total", path: sample.query.path },
        },
        toolContext(root, { knowledge: index }),
      );
      expect(outcome.isError).toBe(false);
      expect(outcome.content).toMatch(/^Approximate:/);
    });

    it(`${language}: callers and impact carry the reference warning`, async () => {
      const root = await project(sample.files);
      const index = new KnowledgeIndex(root);
      const callers = await index.findCallers("total", sample.query.path);
      expect(callers).toMatchObject({ approximate: true });
      expect(callersText(callers)).toMatch(/^Approximate:/);
      const impact = await index.impactAnalysis(sample.query.path);
      expect(impact).toMatchObject({ approximate: true });
      expect(impactAnalysisText(impact)).toMatch(/^Approximate:/);
      expect(impactAnalysisText(impact)).toContain("heuristic");
    });

    it(`${language}: missing definitions and empty callers still warn`, async () => {
      const content = sample.files[sample.query.path];
      if (!content) throw new Error("missing declaration");
      const root = await project({ [sample.query.path]: content });
      const index = new KnowledgeIndex(root);
      const missing = await index.findReferences("missing", sample.query.path);
      expect(missing.references).toHaveLength(0);
      expect(missing).toMatchObject({ approximate: true });
      expect(referencesText(missing)).toMatch(/^Approximate:/);
      const callers = await index.findCallers("total", sample.query.path);
      expect(callers.callers).toHaveLength(0);
      expect(callers).toMatchObject({ approximate: true });
      expect(callersText(callers)).toMatch(/^Approximate:/);
      const impact = await index.impactAnalysis("missing");
      expect(impact.riskLevel).toBe("unknown");
      expect(impact).toMatchObject({ approximate: true });
    });
  }

  it("does not apply a Java/Python warning to a TypeScript result or a TS-only missing query", async () => {
    const root = await project({
      "a.ts": "export function total(): number { return 1; }\nexport const answer = total();\n",
    });
    const index = new KnowledgeIndex(root);
    const refs = await index.findReferences("total", "a.ts");
    expect(refs.references.length).toBeGreaterThan(0);
    expect(referencesText(refs)).not.toMatch(/^Approximate:/);
    expect(referencesText(await index.findReferences("missing"))).not.toMatch(/^Approximate:/);
  });

  it("tool descriptions state the limits instead of promising exhaustive binding resolution", () => {
    expect(findReferencesTool.description).toContain("approximate");
    expect(findReferencesTool.description).not.toContain("Find every use");
    expect(findReferencesTool.description).not.toContain("does not match other symbols");
    expect(findCallersTool.description).toContain("approximate");
    expect(impactAnalysisTool.description).toContain("approximate");
  });

  it("keeps the warning when a matched source line is too large to render", async () => {
    const root = await project({
      "defs.py": "def total(value):\n    return value\n",
      "use.py": `message = "${"total ".repeat(10_000)}"\n`,
    });
    const registry = new ToolRegistry([findReferencesTool]);
    const outcome = await registry.execute(
      {
        type: "tool_use",
        id: "large",
        name: "find_references",
        input: { name: "total", path: "defs.py" },
      },
      toolContext(root, { knowledge: new KnowledgeIndex(root) }),
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toMatch(/^Approximate:/);
    expect(outcome.content.length).toBeLessThan(100_000);
  });

  it("a matching TypeScript query in a mixed project does not inherit another expert's warning", async () => {
    const root = await project({
      "a.ts": "export function total(): number { return 1; }\nexport const answer = total();\n",
      "other.py": "def other():\n    return 1\n",
    });
    const index = new KnowledgeIndex(root);
    expect(referencesText(await index.findReferences("total", "a.ts"))).not.toMatch(
      /^Approximate:/,
    );
    expect(referencesText(await index.findReferences("missing", "a.ts"))).not.toMatch(
      /^Approximate:/,
    );
  });

  // Codex review of 1370184: Go and Rust match identifiers by regular expression, and Garuda cannot
  // vouch for a user plugin; their results carry the same warning as Java/Python.
  it("go and rust: index and tool text keep the approximation", async () => {
    const root = await project({
      "main.go": "package main\n\nfunc Total() int { return 1 }\n\nfunc main() { _ = Total() }\n",
      "src/lib.rs": "pub fn total() -> i32 { 1 }\n\npub fn use_it() -> i32 { total() }\n",
    });
    const index = new KnowledgeIndex(root);
    for (const [name, path] of [
      ["Total", "main.go"],
      ["total", "src/lib.rs"],
    ] as const) {
      const refs = await index.findReferences(name, path);
      expect(refs.definition?.path).toBe(path);
      expect(refs).toMatchObject({ approximate: true });
      expect(referencesText(refs)).toMatch(/^Approximate:/);
    }
    expect(await index.impactAnalysis("main.go")).toMatchObject({ approximate: true });
  });

  it("a user plugin's references are approximate", async () => {
    const root = await project({ "a.rb": "def total\n  1\nend\ntotal\n" });
    const home = await project({
      ".garuda/languages/ruby.js": `export default function create() {
  const hit = { name: "total", kind: "function", path: "a.rb", line: 1, exported: true };
  return {
    id: "ruby",
    extensions: [".rb"],
    summarise: (path) => ({ path, exports: [], imports: [] }),
    findSymbols: (files, query) => (query === "total" ? [hit] : []),
    findReferences: () => ({
      definition: hit,
      references: [{ path: "a.rb", line: 4, text: "total", isDefinition: false }],
      candidates: [hit],
    }),
  };
}
`,
    });
    const refs = await new KnowledgeIndex(root, { home }).findReferences("total", "a.rb");
    expect(refs.references.length).toBe(1);
    expect(refs).toMatchObject({ approximate: true });
  });
});
