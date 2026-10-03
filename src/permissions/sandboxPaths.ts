import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { globbySync } from "globby";
import { CASE_INSENSITIVE_FS, fullGlob } from "./rules.js";

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
  // Garuda's OAuth tokens for remote MCP servers (0.4). The rest of ~/.garuda stays readable:
  // skills and their scripts live there (0.5).
  ".garuda/mcp-auth.json",
  // Claude Code: its config can hold MCP server tokens in env values; its credentials on Linux.
  ".claude.json",
  ".claude/.credentials.json",
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

/** Most paths that a team policy's `denyPaths` adds to one sandbox profile. */
export const MAX_POLICY_DENIED_PATHS = 1_000;

/**
 * The files and folders in the root that the team policy's `denyPaths` names, as absolute paths
 * for the OS sandbox (K6, review): file tools refused them, but `cat secret/x` in `bash` read them.
 * The sandbox needs real paths, so the patterns are matched against the disk when a command
 * starts: a file created later is covered from the next command on. node_modules and .git are
 * not searched.
 */
export function policyDeniedPaths(
  root: string,
  patterns: readonly string[],
  ignoreCase: boolean = CASE_INSENSITIVE_FS,
): string[] {
  if (patterns.length === 0) return [];
  const found = globbySync(patterns.map(fullGlob), {
    cwd: root,
    absolute: true,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
    gitignore: false,
    caseSensitiveMatch: !ignoreCase,
    ignore: ["**/node_modules/**", "**/.git/**"],
  });
  return found.slice(0, MAX_POLICY_DENIED_PATHS);
}
