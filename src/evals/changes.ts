import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { pathMatches } from "../permissions/rules.js";

/**
 * The files that one eval run changed (0.17, T11a; docs/lld/eval-evidence.md): added, changed or
 * deleted, relative to the task's start state. Garuda's own folder, git's data and build output
 * are left out. A change that the task did not need is "unexpected": a pass with extra edits is a
 * weaker result, so the report counts it, but it does not fail the task.
 */

const IGNORED_DIRS = new Set([
  ".git",
  ".garuda",
  "node_modules",
  "target",
  "build",
  "dist",
  "__pycache__",
  ".pytest_cache",
]);
const IGNORED_FILE = /\.(class|pyc)$/;

/** A walk stops at this many files: a huge tree is not a task's start state. */
export const MAX_TRACKED_FILES = 50_000;

/** Path → content hash of every tracked file under `root`. A link records its target. */
export async function treeState(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (out.size >= MAX_TRACKED_FILES) return;
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const full = join(dir, name);
      const info = await lstat(full).catch(() => undefined);
      if (info === undefined) continue;
      if (info.isDirectory()) {
        if (!IGNORED_DIRS.has(name)) await walk(full, path);
      } else if (info.isSymbolicLink()) {
        out.set(path, `link:${await readlink(full).catch(() => "")}`);
      } else if (info.isFile() && !IGNORED_FILE.test(name)) {
        const hash = createHash("sha256");
        hash.update(await readFile(full).catch(() => Buffer.alloc(0)));
        out.set(path, hash.digest("hex"));
      }
    }
  };
  await walk(root, "");
  return out;
}

/** The paths added, changed or deleted between two states, sorted. */
export function changedPaths(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const out = new Set<string>();
  for (const [path, hash] of after) if (before.get(path) !== hash) out.add(path);
  for (const path of before.keys()) if (!after.has(path)) out.add(path);
  return [...out].sort();
}

/**
 * The changed paths that the task did not need: not an expected file (the task's solution, or a
 * repo task's commit) and no match for one of its `allowChanges` globs.
 */
export function unexpectedPaths(
  changed: readonly string[],
  expected: readonly string[],
  allowChanges: readonly string[] = [],
): string[] {
  const known = new Set(expected);
  return changed.filter(
    (path) => !known.has(path) && !allowChanges.some((glob) => pathMatches(glob, path, false)),
  );
}
