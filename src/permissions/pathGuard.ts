import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Path guard (F15). Tools accept only paths inside the working root.
 * The check runs twice: once on the path as written, and once on the real path,
 * so a symbolic link cannot lead out of the root.
 */

export class PathOutsideRootError extends Error {
  constructor(input: string) {
    super(`Path "${input}" is outside the working root.`);
    this.name = "PathOutsideRootError";
  }
}

/** True when `child` is `parent` or is inside it. Both paths must be absolute. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Resolve `input` (relative to the root, or absolute) to an absolute path inside the root.
 * The path does not need to exist. Throws PathOutsideRootError.
 */
export async function resolveInRoot(root: string, input: string): Promise<string> {
  const absolute = resolve(root, input === "" ? "." : input);
  if (!isInside(root, absolute)) throw new PathOutsideRootError(input);

  const realRoot = await realpath(root);
  const realTarget = await realpathOfNearestExisting(absolute);
  if (!isInside(realRoot, realTarget)) throw new PathOutsideRootError(input);
  return absolute;
}

/** The real path of `path`, or of its nearest existing parent folder. */
async function realpathOfNearestExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      const real = await realpath(current);
      // Add back the parts that do not exist yet.
      return resolve(real, relative(current, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return path;
      current = parent;
    }
  }
}

/** A path relative to the root with forward slashes, for output to the model. */
export function displayPath(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel === "" ? "." : rel.split(sep).join("/");
}
