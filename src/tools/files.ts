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

/** Patterns may not leave the search folder. */
export function assertSafePattern(pattern: string): void {
  if (pattern.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pattern)) {
    throw new Error("Use a pattern relative to the search folder, not an absolute path.");
  }
  if (pattern.split(/[\\/]/).includes("..")) {
    throw new Error('A pattern may not contain "..".');
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
