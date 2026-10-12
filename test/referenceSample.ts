import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { KnowledgeIndex } from "../src/knowledge/index.js";

const schema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  limit: z.number().int().positive(),
  unit: z.string(),
  groundTruth: z.string(),
  cases: z.array(
    z.object({
      id: z.string(),
      language: z.enum(["java", "python"]),
      feature: z.string(),
      files: z.record(z.string(), z.string()),
      query: z.object({
        name: z.string(),
        path: z.string(),
        definitionLine: z.number().int().positive(),
      }),
      expected: z.array(z.string()),
    }),
  ),
});

// Line endings do not change the evidence (Codex review of 1370184); see sourceHash.
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");
const corpusBytes = readFileSync(
  new URL("./fixtures/code-intelligence-references.json", import.meta.url),
);
export const referenceCorpus = schema.parse(JSON.parse(corpusBytes.toString("utf8")));

type Sample = (typeof referenceCorpus.cases)[number];
interface ScoredCase {
  id: string;
  language: Sample["language"];
  feature: string;
  query: Sample["query"];
  expected: string[];
  actual: string[];
  truePositives: string[];
  falsePositives: string[];
  falseNegatives: string[];
}

export async function measureReferenceSample() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-reference-sample-")));
  const cases: ScoredCase[] = [];
  try {
    for (const sample of referenceCorpus.cases) {
      const root = join(base, sample.id);
      for (const [path, content] of Object.entries(sample.files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      }
      const result = await new KnowledgeIndex(root).findReferences(
        sample.query.name,
        sample.query.path,
        referenceCorpus.limit,
      );
      if (
        result.definition &&
        (result.definition.path !== sample.query.path ||
          result.definition.line !== sample.query.definitionLine)
      )
        throw new Error(
          `${sample.id}: selected declaration changed; review the frozen ground truth`,
        );
      const declaration = `${sample.query.path}:${sample.query.definitionLine}`;
      const expected = new Set(sample.expected);
      // The matching engine returns one hit per line. Score unique sites, not occurrences;
      // remove only the selected declaration, without trusting the engine's isDefinition flag.
      const actual = new Set(
        result.references.map((r) => `${r.path}:${r.line}`).filter((site) => site !== declaration),
      );
      cases.push({
        id: sample.id,
        language: sample.language,
        feature: sample.feature,
        query: sample.query,
        expected: [...expected].sort(),
        actual: [...actual].sort(),
        truePositives: [...actual].filter((site) => expected.has(site)).sort(),
        falsePositives: [...actual].filter((site) => !expected.has(site)).sort(),
        falseNegatives: [...expected].filter((site) => !actual.has(site)).sort(),
      });
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const metrics = (rows: typeof cases) => {
    const truePositives = rows.reduce((n, r) => n + r.truePositives.length, 0);
    const falsePositives = rows.reduce((n, r) => n + r.falsePositives.length, 0);
    const falseNegatives = rows.reduce((n, r) => n + r.falseNegatives.length, 0);
    return {
      queries: rows.length,
      truePositives,
      falsePositives,
      falseNegatives,
      precision:
        truePositives + falsePositives === 0
          ? null
          : truePositives / (truePositives + falsePositives),
      recall:
        truePositives + falseNegatives === 0
          ? null
          : truePositives / (truePositives + falseNegatives),
    };
  };
  const sourceFiles = [
    "src/knowledge/index.ts",
    "src/knowledge/java.ts",
    "src/knowledge/python.ts",
  ];
  return {
    schemaVersion: 1,
    corpusId: referenceCorpus.id,
    corpusSha256: hash(corpusBytes),
    measuredSources: sourceFiles.map((path) => ({
      path,
      sha256: hash(readFileSync(new URL(`../${path}`, import.meta.url))),
    })),
    unit: referenceCorpus.unit,
    groundTruth: referenceCorpus.groundTruth,
    limit: referenceCorpus.limit,
    languages: {
      java: metrics(cases.filter((r) => r.language === "java")),
      python: metrics(cases.filter((r) => r.language === "python")),
    },
    combined: metrics(cases),
    cases,
  };
}
