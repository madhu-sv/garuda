import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { KnowledgeIndex } from "../src/knowledge/index.js";

/**
 * SHA-256 of a text file with LF line endings (Codex review of 1370184): a checkout with CRLF
 * (Windows, core.autocrlf) measures the same code and must give the same evidence. LF content
 * keeps its plain SHA-256.
 */
export const sourceHash = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");
const hash = sourceHash;
const language = z.enum(["java", "python"]);
const position = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});
const location = z.object({
  path: z.string(),
  range: z.object({ start: position, end: position }),
});
const query = z.object({
  id: z.string(),
  feature: z.string(),
  name: z.string(),
  path: z.string(),
  definitionLine: z.number().int().positive(),
  character: z.number().int().nonnegative(),
});
const corpusSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  limit: z.number().int().positive(),
  unit: z.string(),
  selection: z.string(),
  projects: z
    .array(
      z.object({
        language,
        files: z.record(z.string(), z.string()),
        queries: z.array(query).length(30),
      }),
    )
    .length(2),
});
const oracleSchema = z.object({
  schemaVersion: z.literal(1),
  corpusId: z.string(),
  corpusSha256: z.string(),
  capturedAt: z.string(),
  toolchain: z.object({
    jdtls: z.object({
      version: z.literal("1.61.0"),
      coreJar: z.string(),
      coreJarSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    pyright: z.object({ version: z.literal("1.1.406") }),
    java: z.string(),
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
  }),
  projects: z
    .array(
      z.object({
        language,
        server: z.unknown(),
        stablePasses: z.literal(2),
        cases: z
          .array(
            z.object({
              id: z.string(),
              expected: z.array(z.string()).nonempty(),
              locations: z.array(location).nonempty(),
            }),
          )
          .length(30),
      }),
    )
    .length(2),
});
const corpusBytes = readFileSync(
  new URL("./fixtures/code-intelligence-lsp-corpus.json", import.meta.url),
);
export const lspReferenceCorpus = corpusSchema.parse(JSON.parse(corpusBytes.toString("utf8")));

export function validateReferenceOracle(input: unknown) {
  const oracle = oracleSchema.parse(input);
  if (oracle.corpusId !== lspReferenceCorpus.id || oracle.corpusSha256 !== hash(corpusBytes))
    throw new Error("Oracle does not match the frozen corpus");
  if (new Set(oracle.projects.map((p) => p.language)).size !== 2)
    throw new Error("Both languages required");
  for (const project of lspReferenceCorpus.projects) {
    if (new Set(project.queries.map((q) => q.id)).size !== 30)
      throw new Error("Duplicate query IDs");
    const gold = oracle.projects.find((p) => p.language === project.language);
    if (!gold) throw new Error("Missing oracle language");
    if (new Set(gold.cases.map((c) => c.id)).size !== 30) throw new Error("Duplicate oracle IDs");
    for (const target of project.queries) {
      const row = gold.cases.find((c) => c.id === target.id);
      if (!row) throw new Error(`Missing oracle: ${target.id}`);
      const definition = `${target.path}:${target.definitionLine}`;
      if (
        !row.locations.some(
          (r) =>
            r.path === target.path &&
            r.range.start.line + 1 === target.definitionLine &&
            r.range.start.character === target.character,
        )
      )
        throw new Error(`Missing selected declaration: ${target.id}`);
      for (const r of row.locations) {
        const lines = project.files[r.path]?.split("\n");
        if (
          !lines ||
          r.range.start.line >= lines.length ||
          r.range.end.line >= lines.length ||
          r.range.start.character > (lines[r.range.start.line]?.length ?? 0) ||
          r.range.end.character > (lines[r.range.end.line]?.length ?? 0) ||
          r.range.end.line < r.range.start.line ||
          (r.range.end.line === r.range.start.line &&
            r.range.end.character <= r.range.start.character)
        )
          throw new Error(`Invalid oracle location: ${target.id}`);
      }
      const normalized = [
        ...new Set(row.locations.map((r) => `${r.path}:${r.range.start.line + 1}`)),
      ]
        .filter((s) => s !== definition)
        .sort();
      if (JSON.stringify(normalized) !== JSON.stringify(row.expected))
        throw new Error(`Oracle site/range mismatch: ${target.id}`);
    }
  }
  return oracle;
}

export function scoreReferenceSites(actual: string[], expected: string[]) {
  const a = new Set(actual),
    e = new Set(expected);
  return {
    actual: [...a].sort(),
    expected: [...e].sort(),
    truePositives: [...a].filter((s) => e.has(s)).sort(),
    falsePositives: [...a].filter((s) => !e.has(s)).sort(),
    falseNegatives: [...e].filter((s) => !a.has(s)).sort(),
  };
}

type Scored = ReturnType<typeof scoreReferenceSites> & {
  id: string;
  language: "java" | "python";
  feature: string;
};
function metrics(rows: Scored[]) {
  const truePositives = rows.reduce((n, r) => n + r.truePositives.length, 0);
  const falsePositives = rows.reduce((n, r) => n + r.falsePositives.length, 0);
  const falseNegatives = rows.reduce((n, r) => n + r.falseNegatives.length, 0);
  return {
    queries: rows.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision:
      truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : null,
    recall:
      truePositives + falseNegatives ? truePositives / (truePositives + falseNegatives) : null,
  };
}

export async function measureLspReferenceSample() {
  const oracleBytes = readFileSync(
    new URL("./fixtures/code-intelligence-lsp-oracle.json", import.meta.url),
  );
  const oracle = validateReferenceOracle(JSON.parse(oracleBytes.toString("utf8")));
  const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-lsp-reference-score-")));
  const cases: Scored[] = [];
  try {
    for (const project of lspReferenceCorpus.projects) {
      const root = join(base, project.language);
      for (const [path, text] of Object.entries(project.files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      const index = new KnowledgeIndex(root);
      const gold = oracle.projects.find((p) => p.language === project.language);
      if (!gold) throw new Error("Missing oracle language");
      for (const target of project.queries) {
        const result = await index.findReferences(
          target.name,
          target.path,
          lspReferenceCorpus.limit,
        );
        if (
          result.definition &&
          (result.definition.path !== target.path ||
            result.definition.line !== target.definitionLine)
        )
          throw new Error(`Selected declaration changed: ${target.id}`);
        if (result.references.length >= lspReferenceCorpus.limit)
          throw new Error("Sample hit its result limit; cannot score truncated output");
        const declaration = `${target.path}:${target.definitionLine}`;
        const actual = result.references
          .map((r) => `${r.path}:${r.line}`)
          .filter((s) => s !== declaration);
        cases.push({
          id: target.id,
          language: project.language,
          feature: target.feature,
          ...scoreReferenceSites(
            actual,
            (() => {
              const row = gold.cases.find((c) => c.id === target.id);
              if (!row) throw new Error(`Missing oracle: ${target.id}`);
              return row.expected;
            })(),
          ),
        });
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  return {
    schemaVersion: 1,
    corpusId: lspReferenceCorpus.id,
    corpusSha256: hash(corpusBytes),
    oracleSha256: hash(oracleBytes),
    measuredSources: [
      "src/knowledge/index.ts",
      "src/knowledge/java.ts",
      "src/knowledge/python.ts",
    ].map((path) => ({ path, sha256: hash(readFileSync(new URL(`../${path}`, import.meta.url))) })),
    unit: lspReferenceCorpus.unit,
    selection: lspReferenceCorpus.selection,
    limit: lspReferenceCorpus.limit,
    languages: {
      java: metrics(cases.filter((r) => r.language === "java")),
      python: metrics(cases.filter((r) => r.language === "python")),
    },
    combined: metrics(cases),
    cases,
  };
}

/**
 * Fixed floors for the frozen LSP sample (Codex review of 1370184): the values measured at T10.
 * Before, the published JSON was the only bar, and a refresh with a worse matcher lowered it.
 * Change a floor only in a reviewed commit that says why.
 */
export const LSP_FLOORS = {
  java: { precision: 33 / 54, recall: 33 / 36 },
  python: { precision: 45 / 63, recall: 45 / 48 },
} as const;

/** Throw when a language is under its fixed precision or recall floor. */
export function checkLspFloors(report: {
  languages: Record<keyof typeof LSP_FLOORS, { precision: number | null; recall: number | null }>;
}): void {
  for (const lang of ["java", "python"] as const) {
    for (const metric of ["precision", "recall"] as const) {
      const value = report.languages[lang][metric];
      const floor = LSP_FLOORS[lang][metric];
      // No predictions or no gold sites (null) is under every floor.
      if (value === null || !(value + 1e-12 >= floor)) {
        throw new Error(
          `${lang} ${metric} ${value?.toFixed(4) ?? "none"} is under the floor ${floor.toFixed(4)}`,
        );
      }
    }
  }
}

/**
 * The path for an evidence refresh, from `name` in `env`. A refresh rewrites the published file,
 * so it is refused in CI: there, the run must compare, never write.
 */
export function evidenceOutput(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const output = env[name];
  if (!output) return undefined;
  if (env.CI) throw new Error(`${name} is set in CI: evidence refreshes are local and reviewed.`);
  return output;
}
