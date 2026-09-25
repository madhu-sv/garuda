import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, sep } from "node:path";
import {
  JDTLS_INIT_OPTIONS,
  JDTLS_READY,
  JDTLS_VERSION,
  type JdtlsLaunchContext,
  jdtlsLaunch,
} from "./jdtls.js";

/**
 * Language servers for diagnostics (0.4): which languages, which servers, and where Garuda finds
 * them. Discovery only reads the file system; it never starts a program (N8: only the Executor
 * does that).
 */

export const LSP_LANGUAGES = ["typescript", "python", "java"] as const;
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
  ".java": { language: "java", id: "java" },
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
  /** Where the managed install puts the program, relative to its folder. Default: node_modules/.bin/<bin>. */
  managed?: string;
  /** Build the command (default: the program and `args`), or say why it cannot start. */
  launch?: (path: string, context: LaunchContext) => { argv: string[] } | { problem: string };
  /** initializationOptions for the server. */
  initializationOptions?: unknown;
  /** A notification that says the server is ready; the first check waits for it. */
  ready?: { method: string; test: (params: unknown) => boolean };
  /** Wait for the first result (the server imports the project). Default: the manager's. */
  firstTimeoutMs?: number;
}

export type LaunchContext = JdtlsLaunchContext;

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
  java: [
    {
      name: "jdtls",
      bin: "jdtls",
      args: [],
      managed: join("jdtls", "bin", "jdtls"),
      launch: jdtlsLaunch,
      initializationOptions: JDTLS_INIT_OPTIONS,
      ready: JDTLS_READY,
      // The first import of a Maven or Gradle project takes a while.
      firstTimeoutMs: 120_000,
    },
  ],
};

/** What `garuda lsp install <language>` puts in ~/.garuda/lsp/<language>. Pinned versions. */
export const MANAGED: Readonly<
  Record<LspLanguage, { kind: "npm"; packages: readonly string[] } | { kind: "eclipse" }>
> = {
  typescript: { kind: "npm", packages: ["typescript@7.0.2"] },
  python: { kind: "npm", packages: ["pyright@1.1.414"] },
  java: { kind: "eclipse" },
};

/** The managed install in words, for the install question. */
export function managedLabel(language: LspLanguage): string {
  const m = MANAGED[language];
  return m.kind === "npm"
    ? m.packages.join(", ")
    : `jdtls ${JDTLS_VERSION} (from download.eclipse.org)`;
}

export function managedDir(language: LspLanguage, home: string = homedir()): string {
  return join(home, ".garuda", "lsp", language);
}

export interface FoundServer {
  spec: ServerSpec;
  /** Absolute path of the program. */
  path: string;
  source: "managed" | "path";
  /** The command that starts it. */
  argv: string[];
}

export interface DiscoverOptions {
  root: string;
  home?: string;
  /** Default: process.env.PATH. */
  path?: string;
  /** For `launch`: Garuda's environment (JAVA_HOME) and the JDK folders to search. */
  env?: NodeJS.ProcessEnv;
  jdkFolders?: string[];
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
  return findServer(language, options).server;
}

/** Like discoverServer, and also the reasons why found programs cannot start (for /lsp). */
export function findServer(
  language: LspLanguage,
  options: DiscoverOptions,
): { server?: FoundServer; problems: string[] } {
  const home = options.home ?? homedir();
  const managed = managedDir(language, home);
  const dirs = (options.path ?? process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => isAbsolute(dir) && !inside(options.root, dir));
  const problems: string[] = [];
  const context: LaunchContext = {
    root: options.root,
    home,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.jdkFolders === undefined ? {} : { jdkFolders: options.jdkFolders }),
  };
  for (const source of ["managed", "path"] as const) {
    for (const spec of SERVERS[language]) {
      const paths =
        source === "managed"
          ? [join(managed, spec.managed ?? join("node_modules", ".bin", spec.bin))]
          : dirs.map((dir) => join(dir, spec.bin));
      for (const path of paths) {
        if (!isProgram(path)) continue;
        if (spec.accept !== undefined && !spec.accept(path)) continue;
        const launch = spec.launch?.(path, context) ?? { argv: [path, ...spec.args] };
        if ("problem" in launch) {
          problems.push(launch.problem);
          continue;
        }
        return { server: { spec, path, source, argv: launch.argv }, problems };
      }
    }
  }
  return { problems };
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
