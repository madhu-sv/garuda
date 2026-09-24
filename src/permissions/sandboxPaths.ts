import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Default paths for the OS sandbox (0.2). Commands may read everything except
 * DENY_READ, and write only the root, temp folders and tool caches.
 */

/** Secrets under the home folder. Commands in the sandbox cannot read them. */
export const DENY_READ_IN_HOME = [
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".docker",
  ".config/gcloud",
  ".config/gh",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "Library/Keychains",
];

/**
 * Paths in the root that stay read-only for commands. A git hook or Garuda's own
 * settings would run or apply later, outside the sandbox, so a command must not write them.
 */
export const PROTECTED_IN_ROOT = [".git/hooks", ".git/config", ".garuda"];

/** Temp folders and package caches that builds and tests write. */
export const WRITE_IN_HOME = [
  ".cache",
  ".npm",
  ".local/share/pnpm",
  "Library/Caches",
  "Library/pnpm",
];

export interface SandboxPaths {
  writePaths: string[];
  denyWritePaths: string[];
  denyReadPaths: string[];
}

export interface SandboxSettings {
  /** Extra writable paths. `~/` is the home folder; relative paths start at the root. */
  writePaths?: string[];
  /** Extra paths commands may not read. */
  denyRead?: string[];
}

export function sandboxPaths(
  root: string,
  settings: SandboxSettings = {},
  home: string = homedir(),
): SandboxPaths {
  const expand = (path: string) =>
    path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : resolve(root, path);
  const temp = [...new Set([real(tmpdir()), real("/tmp")])];
  return {
    writePaths: unique([
      root,
      ...temp,
      ...WRITE_IN_HOME.map((p) => join(home, p)),
      ...(settings.writePaths ?? []).map(expand),
    ]),
    denyWritePaths: PROTECTED_IN_ROOT.map((p) => join(root, p)),
    denyReadPaths: unique([
      ...DENY_READ_IN_HOME.map((p) => join(home, p)),
      ...(settings.denyRead ?? []).map(expand),
    ]),
  };
}

/** Sandbox rules need real paths: on macOS /tmp is a link to /private/tmp. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function unique(paths: string[]): string[] {
  return [...new Set(paths.filter((p) => isAbsolute(p)))];
}
