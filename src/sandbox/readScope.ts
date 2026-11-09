import { dirname, sep } from "node:path";

/**
 * What a sandboxed command may read in "needed" mode (T15, docs/lld/reads.md). The permission
 * engine builds it (src/permissions/reads.ts); Seatbelt and bubblewrap turn it into rules.
 */
export interface ReadScope {
  /** The home folder, a real path: everything in it is denied except `allow`. */
  home: string;
  /** Readable paths in `home` or in a `hide` folder (real paths). The write paths there too. */
  allow: string[];
  /** Folders outside the home folder that are denied the same way: other volumes. */
  hide: string[];
}

const inside = (path: string, base: string) => path === base || path.startsWith(`${base}${sep}`);

/** The scope's bases: the home folder and the hidden places. */
export const scopeBases = (scope: ReadScope): string[] => [scope.home, ...scope.hide];

/** Write paths in the scope's home folder or hidden places: they must stay readable. */
export function writableInScope(scope: ReadScope, writePaths: readonly string[]): string[] {
  return writePaths.filter((p) => scopeBases(scope).some((b) => inside(p, b) && p !== b));
}

/**
 * The folders on the way from a base to each readable path: a tool may `stat` them (Node's
 * realpath does), but not list them. Seatbelt needs them as metadata-only rules.
 */
export function readAncestors(scope: ReadScope, extra: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const path of [...scope.allow, ...extra]) {
    const base = scopeBases(scope).find((b) => inside(path, b));
    if (base === undefined) continue;
    out.add(base);
    for (let dir = dirname(path); inside(dir, base) && dir !== base; dir = dirname(dir)) {
      out.add(dir);
    }
  }
  return [...out].sort();
}

/**
 * True when a write path is the home folder itself (`"~"` in `sandbox.writePaths`): the user made
 * all of it writable, so the scope does not hide it. A writable parent (a temp folder that holds a
 * test's home) does not count: bubblewrap mounts it first, and Seatbelt's read rules come after
 * its write rules.
 */
export function homeIsWritable(scope: ReadScope, writePaths: readonly string[]): boolean {
  return writePaths.includes(scope.home);
}
