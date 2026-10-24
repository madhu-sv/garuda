import { describe, expect, it } from "vitest";
import { assertSafePattern, braceExpansion, MAX_BRACE_PATTERNS } from "../src/tools/files.js";

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
