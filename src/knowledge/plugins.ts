import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TrustStore } from "../mcp/trust.js";
import { createJavaExpert } from "./java.js";
import { createGoExpert } from "./plugins/go.js";
import { createRustExpert } from "./plugins/rust.js";
import { createPythonExpert } from "./python.js";
import type { ExpertFactory, LanguageExpert, LanguagePlugin } from "./types.js";
import { createTypeScriptExpert } from "./typescript.js";

export const BUILTIN_PLUGINS: readonly LanguagePlugin[] = [
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    source: "built-in",
    factory: createTypeScriptExpert,
  },
  {
    id: "python",
    extensions: [".py"],
    source: "built-in",
    factory: createPythonExpert,
  },
  {
    id: "java",
    extensions: [".java"],
    source: "built-in",
    factory: createJavaExpert,
  },
  {
    id: "go",
    extensions: [".go"],
    source: "built-in",
    factory: createGoExpert,
  },
  {
    id: "rust",
    extensions: [".rs"],
    source: "built-in",
    factory: createRustExpert,
  },
];

export interface PluginDiscoveryOptions {
  root: string;
  home?: string | undefined;
  trust?: TrustStore | undefined;
  includeBuiltins?: boolean | undefined;
}

export async function discoverPlugins({
  root,
  home = homedir(),
  trust,
  includeBuiltins = true,
}: PluginDiscoveryOptions): Promise<{
  plugins: LanguagePlugin[];
  warnings: string[];
}> {
  const plugins: LanguagePlugin[] = includeBuiltins ? [...BUILTIN_PLUGINS] : [];
  const warnings: string[] = [];

  // 1. User plugins: ~/.garuda/languages/
  const userDir = join(home, ".garuda", "languages");
  const userFiles = await safeReaddir(userDir);

  for (const filename of userFiles) {
    if (!isPluginFile(filename)) continue;
    const fullPath = join(userDir, filename);
    const id = basename(filename, extname(filename));

    try {
      const plugin = await loadPluginModule(fullPath, id, "user");
      if (plugin) {
        plugins.push(plugin);
      }
    } catch (error) {
      warnings.push(`Failed to load user language plugin "${id}": ${(error as Error).message}`);
    }
  }

  // 2. Project plugins: <root>/.garuda/languages/
  const projDir = join(root, ".garuda", "languages");
  const projFiles = await safeReaddir(projDir);

  for (const filename of projFiles) {
    if (!isPluginFile(filename)) continue;
    const fullPath = join(projDir, filename);
    const id = basename(filename, extname(filename));

    try {
      const content = await readFile(fullPath, "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      const approvedHash = trust?.languageHash(root, id);

      if (approvedHash === undefined || approvedHash !== hash) {
        warnings.push(
          `Project language plugin "${id}" at ${fullPath} is not approved in ~/.garuda/trust.json. Skipped.`,
        );
        continue;
      }

      const plugin = await loadPluginModule(fullPath, id, "project");
      if (plugin) {
        plugins.push(plugin);
      }
    } catch (error) {
      warnings.push(`Failed to load project language plugin "${id}": ${(error as Error).message}`);
    }
  }

  return { plugins, warnings };
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function isPluginFile(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return ext === ".js" || ext === ".mjs" || ext === ".ts";
}

async function loadPluginModule(
  filePath: string,
  id: string,
  source: "user" | "project",
): Promise<LanguagePlugin | undefined> {
  const url = pathToFileURL(filePath).href;
  const mod = await import(url);
  const exported = mod.default ?? mod;

  if (typeof exported === "function") {
    // Factory function: (root) => LanguageExpert
    const sample = await exported(".");
    return {
      id: sample.id ?? id,
      extensions: sample.extensions ?? [],
      source,
      path: filePath,
      factory: exported as ExpertFactory,
    };
  }

  if (typeof exported === "object" && exported !== null) {
    // Already an expert instance or plugin descriptor
    if (typeof exported.factory === "function") {
      return {
        id: exported.id ?? id,
        extensions: exported.extensions ?? [],
        source,
        path: filePath,
        factory: exported.factory,
      };
    }

    if (Array.isArray(exported.extensions) && typeof exported.summarise === "function") {
      return {
        id: exported.id ?? id,
        extensions: exported.extensions,
        source,
        path: filePath,
        factory: () => exported as LanguageExpert,
      };
    }
  }

  return undefined;
}
