import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { policyDeniedPaths } from "../src/permissions/sandboxPaths.js";
import {
  assertSafePattern,
  braceExpansion,
  listFiles,
  MAX_BRACE_PATTERNS,
} from "../src/tools/files.js";

describe("brace expansion limit (0.17, GHSA-vfj7-8cjw-p6xm)", () => {
  it("bounds the patterns from groups, nesting and ranges, never too low", () => {
    expect(braceExpansion("**/*.ts")).toEqual({ patterns: 1, depth: 0 });
    expect(braceExpansion("**/*.{ts,tsx}")).toEqual({ patterns: 2, depth: 1 });
    expect(braceExpansion("{src,test}/**/*.{ts,tsx,js}").patterns).toBe(6);
    // Nested: the real count is 3; the bound may be higher, never lower.
    expect(braceExpansion("{a,{b,c}}").patterns).toBeGreaterThanOrEqual(3);
    expect(braceExpansion("{a,{b,c}}").depth).toBe(2);
    expect(braceExpansion("f{1..10}").patterns).toBe(10);
    expect(braceExpansion("f{01..10..2}").patterns).toBe(5);
    expect(braceExpansion("{a..z}").patterns).toBe(26);
    expect(braceExpansion("{1..9999999}").patterns).toBe(9_999_999);
    // An escaped brace is no group; an unclosed one is text.
    expect(braceExpansion("\\{a,b\\}").patterns).toBe(1);
    expect(braceExpansion("{a,b").patterns).toBe(1);
  });

  it("refuses the patterns that ran Garuda out of memory or stack", () => {
    expect(() => assertSafePattern("{a,b}".repeat(1900))).toThrow(/expands to more than/);
    expect(() => assertSafePattern("{1..9999999}")).toThrow(/expands to more than/);
    expect(() => assertSafePattern(`${"{".repeat(4999)}${"}".repeat(4999)}`)).toThrow(/deep/);
    expect(braceExpansion("{a,b}".repeat(1900)).patterns).toBe(Number.MAX_SAFE_INTEGER);
    // The limit itself is allowed: 10 alternatives, 100 alternatives.
    expect(() => assertSafePattern("{0,1,2,3,4,5,6,7,8,9}{0,1,2,3,4,5,6,7,8,9}*.ts")).not.toThrow();
    expect(MAX_BRACE_PATTERNS).toBe(1000);
  });
});

describe("no extglobs (GHSA-fc5q-39xc-vjpf)", () => {
  // picomatch has no fix: `+(*a)` on a long name backtracks for seconds, and the event loop stops.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-extglob-")));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(join(base, `${"a".repeat(27)}b`), "");

  it("the glob tool's search ends at once", async () => {
    for (const pattern of ["+(*a)", "*(*a)"]) {
      const started = Date.now();
      expect(await listFiles(base, pattern, base)).toEqual([]);
      expect(Date.now() - started, pattern).toBeLessThan(1_000);
    }
    // Plain globs still work.
    expect(await listFiles(base, "*b", base)).toEqual([join(base, `${"a".repeat(27)}b`)]);
  });

  it("the policy's denyPaths too", () => {
    const started = Date.now();
    expect(policyDeniedPaths(base, ["+(*a)"])).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(policyDeniedPaths(base, ["*b"])).toEqual([join(base, `${"a".repeat(27)}b`)]);
  });
});
