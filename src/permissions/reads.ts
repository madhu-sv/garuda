import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import type { ReadScope } from "../sandbox/readScope.js";

/**
 * Reads only where needed (T15, docs/lld/reads.md). In `"needed"` mode a sandboxed command reads,
 * in the home folder, only the project, the toolchain prefixes on PATH, the folders that tools
 * name in the environment, a fixed list of toolchain folders and caches, Garuda's skills and
 * `sandbox.readPaths`. Other volumes are hidden too. The deny list still wins inside all of them.
 */

export type ReadsMode = "open" | "needed";

/** The fixed list (design note, "What is readable"): toolchains and caches, by ecosystem. */
export const NEEDED_IN_HOME = [
  // Node
  ".nvm",
  ".fnm",
  ".local/share/fnm",
  ".volta",
  ".bun",
  ".deno",
  ".npm",
  ".yarn",
  ".local/share/pnpm",
  "Library/pnpm",
  ".cache/node-gyp",
  "Library/Caches/node-gyp",
  ".cache/ms-playwright",
  "Library/Caches/ms-playwright",
  "Library/Caches/typescript",
  "Library/Caches/Yarn",
  ".cache/yarn",
  // Python
  ".pyenv",
  ".local/lib",
  ".local/share/uv",
  ".cache/uv",
  ".cache/pip",
  "Library/Caches/pip",
  ".cache/pypoetry",
  "Library/Caches/pypoetry",
  ".virtualenvs",
  ".conda",
  "miniconda3",
  "miniforge3",
  "anaconda3",
  // JVM: the caches, not the folders' own settings files (decision 3)
  ".m2/repository",
  ".gradle/caches",
  ".gradle/wrapper",
  ".gradle/jdks",
  ".sdkman",
  ".jdks",
  "Library/Java",
  ".ivy2",
  ".sbt",
  ".cache/coursier",
  "Library/Caches/Coursier",
  // Go, Rust
  "go",
  ".cache/go-build",
  "Library/Caches/go-build",
  ".cargo/bin",
  ".cargo/registry",
  ".cargo/git",
  ".rustup",
  // Ruby
  ".rbenv",
  ".rvm",
  ".gem/ruby",
  ".bundle/cache",
  // Mobile
  "Library/Android/sdk",
  "Android/Sdk",
  ".android/avd",
  "Library/Developer",
  ".pub-cache",
  ".cocoapods",
  "Library/Caches/CocoaPods",
  ".swiftpm",
  "Library/org.swift.swiftpm",
  // .NET
  ".dotnet",
  ".nuget/packages",
  // General
  ".local/bin",
  ".gitconfig",
  ".gitignore_global",
  ".gitignore",
  ".config/git",
  ".terminfo",
  "Library/Caches/Homebrew",
  // Garuda: skill and agent scripts run in the sandbox
  ".garuda/skills",
  ".garuda/agents",
  ".claude/skills",
  ".claude/agents",
];

/** Variables that name a toolchain's folder; each value in the home folder is readable. */
export const NEEDED_ENV = [
  "NVM_DIR",
  "VOLTA_HOME",
  "PNPM_HOME",
  "BUN_INSTALL",
  "PYENV_ROOT",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "GOPATH",
  "GOMODCACHE",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "SDKMAN_DIR",
  "JAVA_HOME",
  "GRADLE_USER_HOME",
  "MAVEN_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "PUB_CACHE",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
];

/**
 * Settings files that can hold passwords but that builds also read for other settings
 * (decision 3): denied in "needed" mode, also when a variable such as GRADLE_USER_HOME opens their
 * folder. A build that needs one gets it back with `sandbox.readPaths`.
 */
export const NEEDED_MODE_DENY = [
  ".m2/settings.xml",
  ".gradle/gradle.properties",
  ".yarnrc.yml",
  ".nuget/NuGet/NuGet.Config",
];

/** The project's links that a task copy or a worktree has (as `LINK_CANDIDATES` in jobs). */
const PROJECT_LINKS = ["node_modules", ".venv", "venv"];

/** Other volumes: external disks and backups. */
export function hiddenPlaces(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") return ["/Volumes"];
  if (platform === "linux") return ["/media", "/mnt"];
  return [];
}

const inside = (path: string, base: string) => path === base || path.startsWith(`${base}${sep}`);

/** A real path when it exists, else the path itself. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export interface NeededReadsInput {
  home: string;
  root: string;
  writePaths: readonly string[];
  /** `sandbox.readPaths`, already absolute. */
  readPaths: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** The read scope of "needed" mode for one project. */
export function neededReads(input: NeededReadsInput): ReadScope {
  const env = input.env ?? process.env;
  const home = real(input.home);
  const homeAsGiven = input.home;
  const hide = hiddenPlaces(input.platform).filter((h) => !inside(home, h));
  const candidates: string[] = [input.root, ...input.writePaths, ...input.readPaths];
  for (const name of PROJECT_LINKS) candidates.push(join(input.root, name));
  // The toolchain prefixes on PATH: ~/.nvm/versions/node/v22/bin gives .../v22 (npm's modules).
  for (const entry of (env.PATH ?? "").split(":")) {
    if (!isAbsolute(entry)) continue;
    candidates.push(basename(entry) === "bin" ? dirname(entry) : entry);
  }
  for (const name of NEEDED_ENV) {
    const value = env[name];
    if (value !== undefined && isAbsolute(value)) candidates.push(value);
  }
  for (const entry of NEEDED_IN_HOME) candidates.push(join(home, entry));
  const allow = new Set<string>();
  // The home folder as tools name it, when it is a link (macOS: /var -> /private/var for a test).
  const asReal = (p: string) =>
    homeAsGiven !== home && inside(p, homeAsGiven) ? join(home, p.slice(homeAsGiven.length)) : p;
  for (const path of candidates) {
    // A link in the home folder that points elsewhere in it: both are needed.
    for (const p of new Set([asReal(path), real(path)])) {
      if (inside(p, home) && p !== home) allow.add(p);
      else if (hide.some((h) => inside(p, h) && p !== h)) allow.add(p);
    }
  }
  return { home, allow: [...allow].sort(), hide };
}
