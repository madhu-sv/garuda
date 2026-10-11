import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpathOfNearestExisting } from "./pathGuard.js";

/**
 * The write scope of a scheduled job (0.17, review T6; docs/lld/bounded-changes.md): the paths in
 * its worktree that its commands and edits may change. An entry that ends in "/" is a folder
 * (`src/`); any other entry is one file (`README.md`). Everything else in the worktree is
 * read-only for the job's commands (OS sandbox) and denied for its edits (permission engine).
 */

/** One scope entry: relative, no "..", not the root, no backslash or control character. */
export function scopeEntryProblem(entry: string): string | undefined {
  if (entry === "" || entry === "/" || entry === "." || entry === "./") {
    return `"${entry}" is the whole worktree, not a scope`;
  }
  if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) return `"${entry}" is not relative`;
  const control = [...entry].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
  if (entry.includes("\\") || control) {
    return `"${entry}" has a backslash or a control character`;
  }
  const parts = entry.replace(/\/$/, "").split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    return `"${entry}" has an empty, "." or ".." part`;
  }
  if (parts[0] === ".git" || parts[0] === ".garuda") return `"${entry}" is a protected folder`;
  return undefined;
}

/** Is this root-relative path (with "/" separators) inside the scope? */
export function inWriteScope(path: string, scope: readonly string[]): boolean {
  const clean = path.replace(/^\.\//, "").replace(/\/+$/, "");
  return scope.some((entry) =>
    entry.endsWith("/") ? clean === entry.slice(0, -1) || clean.startsWith(entry) : clean === entry,
  );
}

/** The absolute paths of the scope entries in a root. */
export function scopePaths(root: string, scope: readonly string[]): string[] {
  return scope.map((entry) => join(root, ...entry.replace(/\/$/, "").split("/")));
}

/**
 * Before a job runs: refuse a scope entry that is a symbolic link or that resolves outside the
 * worktree (it would make another place writable), and create missing folder entries, so that the
 * OS sandbox can make them writable (bubblewrap binds only existing paths).
 */
export function prepareWriteScope(root: string, scope: readonly string[]): string | undefined {
  for (const entry of scope) {
    const problem = scopeEntryProblem(entry);
    if (problem !== undefined) return problem;
  }
  const realRoot = realpathSync(root);
  for (const [i, path] of scopePaths(root, scope).entries()) {
    const entry = scope[i] as string;
    let current = root;
    for (const part of entry.replace(/\/$/, "").split("/")) {
      current = join(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
        return `"${entry}" goes through a symbolic link (${current})`;
      }
    }
    if (!existsSync(path) && entry.endsWith("/")) mkdirSync(path, { recursive: true });
    if (existsSync(path)) {
      const real = realpathSync(path);
      if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) {
        return `"${entry}" is outside the worktree`;
      }
    }
  }
  return undefined;
}

/** Folders that builds write, by the marker file of the build tool. */
const BUILD_OUTPUTS: readonly { marker: string; folders: string[] }[] = [
  { marker: "pom.xml", folders: ["target/"] },
  { marker: "build.gradle", folders: ["build/", ".gradle/"] },
  { marker: "build.gradle.kts", folders: ["build/", ".gradle/"] },
  { marker: "package.json", folders: ["dist/", "coverage/"] },
  { marker: "pyproject.toml", folders: ["build/", "dist/", ".pytest_cache/"] },
  { marker: "setup.py", folders: ["build/", "dist/", ".pytest_cache/"] },
  { marker: "Cargo.toml", folders: ["target/"] },
  { marker: "go.mod", folders: [] },
];

/**
 * The scope that /schedule proposes: the paths of the plan's edit_file and write_file rules, and
 * the build output folders of the project. Undefined (the whole worktree) when a rule names no
 * folder (`edit_file(**\/*.ts)`); `reason` says which.
 */
export function proposeWriteScope(
  rules: readonly string[],
  root: string,
): { scope: string[] } | { scope: undefined; reason: string } {
  const entries = new Set<string>();
  for (const rule of rules) {
    const m = /^(edit_file|write_file)\((.*)\)$/.exec(rule.trim());
    if (m === null) continue;
    const pattern = (m[2] as string).replace(/^\.\//, "");
    const glob = pattern.search(/[*?[{]/);
    const entry = glob === -1 ? pattern : pattern.slice(0, pattern.lastIndexOf("/", glob) + 1);
    if (entry === "" || scopeEntryProblem(entry) !== undefined) {
      return { scope: undefined, reason: `the rule ${rule} names no folder` };
    }
    entries.add(entry);
  }
  for (const { marker, folders } of BUILD_OUTPUTS) {
    if (existsSync(join(root, marker))) for (const f of folders) entries.add(f);
  }
  return { scope: [...entries].sort() };
}

/**
 * Why a write to this path is outside the scope, or undefined (second review of 0.17): the path as
 * named AND the place it reaches through symbolic links (for a new file: through its nearest
 * existing parent) must both be in the scope. `path` is root-relative or absolute.
 */
export async function scopeDenial(
  root: string,
  path: string,
  scope: readonly string[],
): Promise<string | undefined> {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const named = relative(root, absolute).split(sep).join("/");
  const outside = (shown: string) =>
    `${shown} is outside this job's write scope (${scope.join(", ")})`;
  if (named.startsWith("..") || !inWriteScope(named, scope)) return outside(named);
  let realRoot: string;
  let real: string;
  try {
    realRoot = await realpath(root);
    real = await realpathOfNearestExisting(absolute);
  } catch {
    return `${named}: its real place cannot be checked`;
  }
  const reached = relative(realRoot, real).split(sep).join("/");
  if (reached === "" || reached.startsWith("..") || isAbsolute(reached)) {
    return `${named} leads outside the worktree`;
  }
  if (!inWriteScope(reached, scope))
    return `${named} leads to ${reached}, which ${outside(reached).slice(reached.length + 1)}`;
  return undefined;
}
