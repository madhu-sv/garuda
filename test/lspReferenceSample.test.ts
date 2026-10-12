import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import {
  checkLspFloors,
  evidenceOutput,
  LSP_FLOORS,
  measureLspReferenceSample,
  scoreReferenceSites,
  sourceHash,
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

// Codex review of 1370184: the published file was the only bar, and a refresh could lower it.
it("fixed precision/recall floors reject a lowered report, whatever the published file says", () => {
  const at = (tp: number, fp: number, fn: number) => ({
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: tp / (tp + fp),
    recall: tp / (tp + fn),
  });
  const good = { languages: { java: at(33, 21, 3), python: at(45, 18, 3) } };
  expect(() => checkLspFloors(good)).not.toThrow();
  expect(() => checkLspFloors({ languages: { ...good.languages, java: at(33, 22, 3) } })).toThrow(
    "java precision",
  );
  expect(() => checkLspFloors({ languages: { ...good.languages, python: at(45, 18, 4) } })).toThrow(
    "python recall",
  );
  expect(LSP_FLOORS).toEqual({
    java: { precision: 33 / 54, recall: 33 / 36 },
    python: { precision: 45 / 63, recall: 45 / 48 },
  });
});

// Codex review of 1370184 (P3): raw-byte hashes failed on a checkout with CRLF line endings
// (Windows, core.autocrlf), although the measured code was the same.
it("evidence hashes do not depend on line endings", () => {
  expect(sourceHash(Buffer.from("a\r\nb\r\n"))).toBe(sourceHash(Buffer.from("a\nb\n")));
  // LF content keeps its plain SHA-256, so the published evidence stays valid.
  expect(sourceHash(Buffer.from("a\nb\n"))).toBe(
    createHash("sha256").update("a\nb\n").digest("hex"),
  );
  expect(sourceHash(Buffer.from("a\nb\n"))).not.toBe(sourceHash(Buffer.from("a\nc\n")));
});

it("an evidence refresh is refused in CI", () => {
  expect(evidenceOutput("GARUDA_LSP_REFERENCE_REPORT", {})).toBeUndefined();
  expect(evidenceOutput("GARUDA_LSP_REFERENCE_REPORT", { GARUDA_LSP_REFERENCE_REPORT: "x" })).toBe(
    "x",
  );
  expect(() =>
    evidenceOutput("GARUDA_LSP_REFERENCE_REPORT", {
      GARUDA_LSP_REFERENCE_REPORT: "x",
      CI: "true",
    }),
  ).toThrow("CI");
});

it("measures all 60 LSP-oracle queries and guards the published precision/recall", async () => {
  const report = await measureLspReferenceSample();
  expect(report.combined.queries).toBe(60);
  // The fixed floors apply always, also to a refresh, so a refresh cannot lower the bar.
  checkLspFloors(report);
  const output = evidenceOutput("GARUDA_LSP_REFERENCE_REPORT", process.env);
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
