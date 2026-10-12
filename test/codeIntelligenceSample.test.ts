import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import { evidenceOutput } from "./lspReferenceSample.js";
import { measureReferenceSample, referenceCorpus } from "./referenceSample.js";

it("measures the frozen Java/Python reference sample and keeps the published evidence current", async () => {
  expect(new Set(referenceCorpus.cases.map((c) => c.id)).size).toBe(referenceCorpus.cases.length);
  for (const sample of referenceCorpus.cases) {
    expect(new Set(sample.expected).size).toBe(sample.expected.length);
    expect(sample.expected).not.toContain(`${sample.query.path}:${sample.query.definitionLine}`);
    for (const site of sample.expected) {
      const [path, line] = site.split(":");
      expect(sample.files[path ?? ""]?.split("\n")[Number(line) - 1]?.trim()).toBeTruthy();
    }
  }
  const report = await measureReferenceSample();
  const output = evidenceOutput("GARUDA_REFERENCE_REPORT", process.env);
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  } else {
    // An implementation or corpus change needs a reviewed evidence update, even if its totals
    // happen to stay the same. No fixed accuracy threshold or production claim is implied.
    const published = JSON.parse(
      readFileSync(
        new URL(
          "../docs/quality-baseline/code-intelligence-reference-results.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(report).toEqual(published);
  }
  console.info("Fixed reference sample", report.languages);
});
