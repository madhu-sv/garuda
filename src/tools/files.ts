import { stat } from "node:fs/promises";
import { globby } from "globby";
import { isInside } from "../permissions/pathGuard.js";

/**
 * List files under `base` that match `pattern`. Respects .gitignore, skips .git,
 * and does not follow symbolic links (F12, F15). Returns absolute paths.
 */
export async function listFiles(base: string, pattern: string, root: string): Promise<string[]> {
  assertSafePattern(pattern);
  const paths = await globby(pattern, {
    cwd: base,
    absolute: true,
    dot: true,
    gitignore: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ["**/.git/**"],
  });
  return paths.filter((path) => isInside(root, path));
}

/**
 * Brace expansion limits (0.17). globby expands `{a,b}` before it matches, through the `braces`
 * package, which has no fix for GHSA-vfj7-8cjw-p6xm. A pattern from the model (glob, grep) such as
 * `{a,b}` 1900 times made 2^1900 patterns: Node ran out of memory and the OS killed Garuda. A deep
 * nesting overflowed the stack.
 */
export const MAX_BRACE_PATTERNS = 1_000;
export const MAX_BRACE_DEPTH = 10;

/** Patterns may not leave the search folder, and may not expand to too many patterns. */
export function assertSafePattern(pattern: string): void {
  if (pattern.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pattern)) {
    throw new Error("Use a pattern relative to the search folder, not an absolute path.");
  }
  if (pattern.split(/[\\/]/).includes("..")) {
    throw new Error('A pattern may not contain "..".');
  }
  const { patterns, depth } = braceExpansion(pattern);
  if (depth > MAX_BRACE_DEPTH) {
    throw new Error(`A pattern may nest {…} at most ${MAX_BRACE_DEPTH} deep.`);
  }
  if (patterns > MAX_BRACE_PATTERNS) {
    throw new Error(
      `This pattern expands to more than ${MAX_BRACE_PATTERNS} patterns through {…}. Use fewer brace groups or alternatives.`,
    );
  }
}

/**
 * An upper bound on the patterns that brace expansion makes from `pattern`, and the deepest
 * nesting. The bound multiplies the alternatives of all groups; a nested group counts as if it
 * stood beside its parent, so the bound is never too low. `\` escapes the next character.
 */
export function braceExpansion(pattern: string): { patterns: number; depth: number } {
  let patterns = 1;
  let depth = 0;
  const open: { alternatives: number; start: number }[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
    } else if (c === "{") {
      open.push({ alternatives: 1, start: i });
      depth = Math.max(depth, open.length);
    } else if (c === "," && open.length > 0) {
      const group = open[open.length - 1];
      if (group !== undefined) group.alternatives++;
    } else if (c === "}") {
      const group = open.pop();
      if (group === undefined) continue;
      const n =
        group.alternatives > 1 ? group.alternatives : rangeSize(pattern.slice(group.start + 1, i));
      patterns = Math.min(patterns * n, Number.MAX_SAFE_INTEGER);
    }
  }
  return { patterns, depth };
}

/** The values of a range body such as `1..10`, `01..10..2` or `a..z`; 1 for anything else. */
function rangeSize(body: string): number {
  const range = /^([+-]?\d+|[A-Za-z])\.\.([+-]?\d+|[A-Za-z])(?:\.\.([+-]?\d+))?$/.exec(body);
  if (range === null) return 1;
  const value = (s: string) => (/^[A-Za-z]$/.test(s) ? s.charCodeAt(0) : Number(s));
  const span = Math.abs(value(range[2] ?? "") - value(range[1] ?? ""));
  const step = Math.max(1, Math.abs(Number(range[3] ?? "1")) || 1);
  return Math.floor(span / step) + 1;
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
