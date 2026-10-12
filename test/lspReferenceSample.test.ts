import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import {
  measureLspReferenceSample,
  scoreReferenceSites,
  validateReferenceOracle,
} from "./lspReferenceSample.js";

const oracle = () =>
  JSON.parse(
    readFileSync(new URL("./fixtures/code-intelligence-lsp-oracle.json", import.meta.url), "utf8"),
  );

it("scores sites independently, without rewarding duplicate hits or empty predictions", () => {
  expect(scoreReferenceSites(["a:2", "a:2", "b:4"], ["a:2", "c:6"])).toEqual({
    actual: ["a:2", "b:4"],
    expected: ["a:2", "c:6"],
    truePositives: ["a:2"],
    falsePositives: ["b:4"],
    falseNegatives: ["c:6"],
  });
  expect(scoreReferenceSites([], ["c:6"]).falseNegatives).toEqual(["c:6"]);
});

it("rejects stale, incomplete, empty or malformed oracle evidence", () => {
  const stale = oracle();
  stale.corpusSha256 = "old";
  expect(() => validateReferenceOracle(stale)).toThrow("frozen corpus");
  const missing = oracle();
  missing.projects[0].cases.pop();
  expect(() => validateReferenceOracle(missing)).toThrow();
  const empty = oracle();
  empty.projects[0].cases[0].expected = [];
  expect(() => validateReferenceOracle(empty)).toThrow();
  const malformed = oracle();
  malformed.projects[0].cases[0].locations[0].range.start.line = 999999;
  expect(() => validateReferenceOracle(malformed)).toThrow();
  const changed = oracle();
  changed.projects[0].cases[0].expected = ["made-up:1"];
  expect(() => validateReferenceOracle(changed)).toThrow("site/range mismatch");
});

it("measures all 60 LSP-oracle queries and guards the published precision/recall", async () => {
  const report = await measureLspReferenceSample();
  expect(report.combined.queries).toBe(60);
  const output = process.env.GARUDA_LSP_REFERENCE_REPORT;
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  } else {
    const published = JSON.parse(
      readFileSync(
        new URL("../docs/quality-baseline/code-intelligence-lsp-results.json", import.meta.url),
        "utf8",
      ),
    );
    for (const lang of ["java", "python"] as const) {
      expect(report.languages[lang].precision).toBeGreaterThanOrEqual(
        published.languages[lang].precision,
      );
      expect(report.languages[lang].recall).toBeGreaterThanOrEqual(
        published.languages[lang].recall,
      );
    }
    // Updating algorithm, gold or corpus also needs an explicit evidence refresh and review.
    expect(report).toEqual(published);
  }
  console.info("Frozen LSP reference sample", report.languages);
});
