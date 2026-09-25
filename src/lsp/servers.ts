import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, sep } from "node:path";

/**
 * Language servers for diagnostics (0.4): which languages, which servers, and where Garuda finds
 * them. Discovery only reads the file system; it never starts a program (N8: only the Executor
 * does that).
 */

export const LSP_LANGUAGES = ["typescript", "python"] as const;
export type LspLanguage = (typeof LSP_LANGUAGES)[number];

/** File extension → language and the LSP languageId. */
const EXTENSIONS: Readonly<Record<string, { language: LspLanguage; id: string }>> = {
  ".ts": { language: "typescript", id: "typescript" },
  ".mts": { language: "typescript", id: "typescript" },
  ".cts": { language: "typescript", id: "typescript" },
  ".tsx": { language: "typescript", id: "typescriptreact" },
  ".js": { language: "typescript", id: "javascript" },
  ".mjs": { language: "typescript", id: "javascript" },
  ".cjs": { language: "typescript", id: "javascript" },
  ".jsx": { language: "typescript", id: "javascriptreact" },
  ".py": { language: "python", id: "python" },
  ".pyi": { language: "python", id: "python" },
};

export function languageOf(path: string): { language: LspLanguage; id: string } | undefined {
  return EXTENSIONS[extname(path).toLowerCase()];
}

export interface ServerSpec {
  /** Short name, shown in results and in /lsp. */
  name: string;
  /** The program to look for. */
  bin: string;
  args: string[];
  /** Extra check on the found program, for example the TypeScript version. */
  accept?: (path: string) => boolean;
}

/** Candidates per language, in order of preference. */
export const SERVERS: Readonly<Record<LspLanguage, readonly ServerSpec[]>> = {
  typescript: [
    // TypeScript 7 (native) has a built-in language server.
    { name: "tsc", bin: "tsc", args: ["--lsp", "--stdio"], accept: isTypeScript7 },
    { name: "tsgo", bin: "tsgo", args: ["--lsp", "--stdio"] },
    { name: "typescript-language-server", bin: "typescript-language-server", args: ["--stdio"] },
  ],
  python: [
    { name: "basedpyright", bin: "basedpyright-langserver", args: ["--stdio"] },
    { name: "pyright", bin: "pyright-langserver", args: ["--stdio"] },
  ],
};

/** What `garuda lsp install <language>` puts in ~/.garuda/lsp/<language>. Pinned versions. */
export const MANAGED_PACKAGES: Readonly<Record<LspLanguage, readonly string[]>> = {
  typescript: ["typescript@7.0.2"],
  python: ["pyright@1.1.414"],
};

export function managedDir(language: LspLanguage, home: string = homedir()): string {
  return join(home, ".garuda", "lsp", language);
}

export interface FoundServer {
  spec: ServerSpec;
  /** Absolute path of the program. */
  path: string;
  source: "managed" | "path";
}

export interface DiscoverOptions {
  root: string;
  home?: string;
  /** Default: process.env.PATH. */
  path?: string;
}

/**
 * Find a server for a language. Order: the managed install, then PATH.
 * PATH entries must be absolute and outside the project: a cloned repository must not be able
 * to plant a "language server" (for example node_modules/.bin) that Garuda then starts.
 */
export function discoverServer(
  language: LspLanguage,
  options: DiscoverOptions,
): FoundServer | undefined {
  const managed = join(managedDir(language, options.home), "node_modules", ".bin");
  const dirs = (options.path ?? process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => isAbsolute(dir) && !inside(options.root, dir));
  for (const [source, list] of [
    ["managed", [managed]],
    ["path", dirs],
  ] as const) {
    for (const spec of SERVERS[language]) {
      for (const dir of list) {
        const path = join(dir, spec.bin);
        if (!isProgram(path)) continue;
        if (spec.accept !== undefined && !spec.accept(path)) continue;
        return { spec, path, source };
      }
    }
  }
  return undefined;
}

function inside(root: string, dir: string): boolean {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // A missing folder cannot hold a program; keep the given path for the check.
  }
  return real === root || real.startsWith(`${root}${sep}`);
}

function isProgram(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * True when `tsc` is TypeScript 7 or later (older versions have no --lsp). It reads the
 * package.json next to the real program, so it runs nothing.
 */
export function isTypeScript7(path: string): boolean {
  let dir: string;
  try {
    dir = dirname(realpathSync(path));
  } catch {
    return false;
  }
  // A pnpm shim in node_modules/.bin is a script, not a link: look at node_modules/typescript.
  const candidates = [join(dir, "..", "typescript", "package.json")];
  for (let i = 0; i < 4; i++, dir = dirname(dir)) candidates.push(join(dir, "package.json"));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "typescript") return Number.parseInt(pkg.version ?? "0", 10) >= 7;
    } catch {
      return false;
    }
  }
  return false;
}
