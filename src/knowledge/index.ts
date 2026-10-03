import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { TrustStore } from "../mcp/trust.js";
import { isSensitive } from "../permissions/sensitive.js";
import { listFiles } from "../tools/files.js";
import { createJavaExpert } from "./java.js";
import { createGoExpert } from "./plugins/go.js";
import { createRustExpert } from "./plugins/rust.js";
import { BUILTIN_PLUGINS, discoverPlugins } from "./plugins.js";
import { createPythonExpert } from "./python.js";
import { braceDepthAt, importNames, pythonEnclosingLine } from "./scope.js";
import type {
  AstQueryOptions,
  CallerHit,
  CallerResult,
  ExpertFactory,
  FileNode,
  ImpactResult,
  LanguageExpert,
  LanguagePlugin,
  LanguageStatus,
  ReferenceHit,
  SymbolHit,
} from "./types.js";
import { createTypeScriptExpert } from "./typescript.js";

export type {
  AstQueryOptions,
  CallerHit,
  CallerResult,
  ExpertFactory,
  FileNode,
  ImpactResult,
  LanguagePlugin,
  LanguageStatus,
  ReferenceHit,
  SymbolHit,
} from "./types.js";

export const GRAPH_FILE = ".garuda/index/code-graph.json";
const GRAPH_VERSION = 1;
const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 1024 * 1024;

/** Experts that Garuda ships. Other languages add their own factory here. */
export const DEFAULT_EXPERTS: readonly ExpertFactory[] = [
  createTypeScriptExpert,
  createPythonExpert,
  createJavaExpert,
  createGoExpert,
  createRustExpert,
];

export interface KnowledgeIndexOptions {
  readonly plugins?: readonly (LanguagePlugin | ExpertFactory)[];
  readonly trust?: TrustStore;
  /**
   * The home folder for user plugins (~/.garuda/languages). Absent: the built-in experts only, so
   * a test or an eval never runs code from the real home folder.
   */
  readonly home?: string;
  /** Root-relative paths that are never indexed (team policy denyPaths, G04). */
  readonly hidden?: (path: string) => boolean;
}

interface GraphCache {
  version: number;
  files: Record<string, { hash: string; node: FileNode }>;
}

/**
 * The local code index: a small code graph (files, their exports, their imports) cached in
 * .garuda/index/code-graph.json, plus definition and reference search from the language
 * experts. Everything runs on this machine: no model call. Files follow .gitignore;
 * sensitive files (F20) are never indexed.
 */
export class KnowledgeIndex {
  private customPlugins?: readonly (LanguagePlugin | ExpertFactory)[];
  private trust?: TrustStore;
  private home?: string;
  private hidden: (path: string) => boolean = () => false;
  private pluginExperts: Array<{ plugin: LanguagePlugin; expert: LanguageExpert }> | undefined;
  private pluginLoading:
    | Promise<Array<{ plugin: LanguagePlugin; expert: LanguageExpert }>>
    | undefined;
  private discoveryWarnings: string[] = [];

  constructor(
    readonly root: string,
    optionsOrPlugins?: readonly (LanguagePlugin | ExpertFactory)[] | KnowledgeIndexOptions,
  ) {
    if (Array.isArray(optionsOrPlugins)) {
      this.customPlugins = optionsOrPlugins;
    } else if (optionsOrPlugins !== undefined) {
      const opts = optionsOrPlugins as KnowledgeIndexOptions;
      if (opts.plugins !== undefined) this.customPlugins = opts.plugins;
      if (opts.trust !== undefined) this.trust = opts.trust;
      if (opts.home !== undefined) this.home = opts.home;
      if (opts.hidden !== undefined) this.hidden = opts.hidden;
    }
  }

  getWarnings(): readonly string[] {
    return this.discoveryWarnings;
  }

  async languageStatuses(): Promise<LanguageStatus[]> {
    const groups = await this.byExpert();
    return groups.map(({ plugin, files }) => ({
      id: plugin.id,
      extensions: plugin.extensions,
      source: plugin.source,
      indexedFiles: files.length,
      active: files.length > 0,
    }));
  }

  async findSymbols(query: string, exact = false, limit = 50): Promise<SymbolHit[]> {
    const hits: SymbolHit[] = [];
    for (const { expert, files } of await this.byExpert()) {
      hits.push(...expert.findSymbols(files, query, exact, limit));
    }
    return hits.slice(0, limit);
  }

  async findReferences(
    name: string,
    inFile?: string,
    limit = 200,
  ): Promise<{ definition?: SymbolHit; references: ReferenceHit[]; candidates: SymbolHit[] }> {
    for (const { expert, files } of await this.byExpert()) {
      const result = expert.findReferences(files, name, inFile, limit);
      if (result.definition !== undefined) {
        return {
          definition: result.definition,
          references: result.references,
          candidates: result.candidates,
        };
      }
    }
    return { references: [], candidates: [] };
  }

  async findCallers(name: string, inFile?: string, limit = 50): Promise<CallerResult> {
    const { definition, references, candidates } = await this.findReferences(
      name,
      inFile,
      limit * 4,
    );
    if (definition === undefined) {
      return { callers: [], candidates };
    }

    const callSites = references.filter((r) => !r.isDefinition);
    if (callSites.length === 0) {
      return { definition, callers: [], candidates };
    }

    const sitesByFile = new Map<string, ReferenceHit[]>();
    for (const site of callSites) {
      const list = sitesByFile.get(site.path) ?? [];
      list.push(site);
      sitesByFile.set(site.path, list);
    }

    const byExpert = await this.byExpert();
    const callers: CallerHit[] = [];

    for (const [filePath, sites] of sitesByFile.entries()) {
      const expertEntry = byExpert.find((e) => e.files.includes(filePath));
      const fileSymbols = expertEntry
        ? expertEntry.expert.findSymbols([filePath], "", false, 500)
        : [];

      const callableSymbols = fileSymbols.filter(
        (s) =>
          s.kind === "function" ||
          s.kind === "method" ||
          s.kind === "constructor" ||
          s.kind === "class",
      );

      const content = await readFile(join(this.root, filePath), "utf8").catch(() => "");
      const lines = content.split("\n");
      for (const site of sites) {
        const enclosing = enclosingSymbol(filePath, content, lines, site.line, callableSymbols);

        const callerName = enclosing
          ? enclosing.container
            ? `${enclosing.container}.${enclosing.name}`
            : enclosing.name
          : "<module>";
        const callerKind = enclosing ? enclosing.kind : "module";
        const line = enclosing ? enclosing.line : 1;

        callers.push({
          callerName,
          callerKind,
          path: site.path,
          line,
          callLine: site.line,
          callText: site.text,
        });

        if (callers.length >= limit) break;
      }
      if (callers.length >= limit) break;
    }

    return { definition, callers, candidates };
  }

  async impactAnalysis(target: string): Promise<ImpactResult> {
    const cleanTarget = target.trim().replace(/^\.\//, "");
    const byExpert = await this.byExpert();
    const allFiles = byExpert.flatMap((e) => e.files);

    let targetKind: "file" | "symbol" = "file";
    let resolvedPath: string | undefined;

    // 1. Try matching as file path
    const fileMatch = allFiles.find((f) => f === cleanTarget || f.endsWith(`/${cleanTarget}`));

    if (fileMatch) {
      targetKind = "file";
      resolvedPath = fileMatch;
    } else {
      // 2. Try matching as symbol
      const symbols = await this.findSymbols(cleanTarget, true, 20);
      if (symbols.length > 0) {
        targetKind = "symbol";
        resolvedPath = symbols[0]?.path;
      } else {
        // Try substring match on file path
        const partialFile = allFiles.find((f) => f.includes(cleanTarget));
        if (partialFile) {
          targetKind = "file";
          resolvedPath = partialFile;
        }
      }
    }

    // Neither a file nor a symbol (before, only the symbol case was caught; a missing name fell
    // through as a "file" with no dependents and came out "low").
    if (!resolvedPath) {
      return {
        target,
        targetKind: "symbol",
        definitions: [],
        dependentFiles: [],
        callers: [],
        affectedTests: [],
        // Not "low" (G08): nothing is known, so nothing is safe to change.
        riskLevel: "unknown",
        summary: `Target "${target}" was not found in the indexed codebase: the risk is unknown.`,
      };
    }

    // 2. Definitions
    let definitions: SymbolHit[] = [];
    if (targetKind === "file" && resolvedPath !== undefined) {
      const targetFilePath = resolvedPath;
      const expertEntry = byExpert.find((e) => e.files.includes(targetFilePath));
      definitions = expertEntry
        ? expertEntry.expert.findSymbols([targetFilePath], "", false, 500)
        : [];
    } else {
      definitions = await this.findSymbols(cleanTarget, true, 20);
    }

    // 3. Dependent Files & Callers
    const dependentFilesSet = new Set<string>();
    const callers: CallerHit[] = [];

    if (targetKind === "symbol") {
      const { references } = await this.findReferences(cleanTarget, resolvedPath, 200);
      for (const ref of references) {
        if (!ref.isDefinition && ref.path !== resolvedPath) {
          dependentFilesSet.add(ref.path);
        }
      }
      const callerRes = await this.findCallers(cleanTarget, resolvedPath, 50);
      callers.push(...callerRes.callers);
    } else if (resolvedPath !== undefined) {
      const targetFilePath = resolvedPath;
      // Find files importing this file directly
      const nodes = await this.repoMap();
      for (const node of nodes) {
        if (node.path === targetFilePath) continue;
        const importsTarget = node.imports.some((imp) =>
          importNames(node.path, imp, targetFilePath),
        );
        if (importsTarget) {
          dependentFilesSet.add(node.path);
        }
      }

      // Check references to exported symbols of this file
      const exportedSymbols = definitions.filter((s) => s.exported);
      for (const sym of exportedSymbols.slice(0, 10)) {
        const { references } = await this.findReferences(sym.name, targetFilePath, 100);
        for (const ref of references) {
          if (!ref.isDefinition && ref.path !== targetFilePath) {
            dependentFilesSet.add(ref.path);
          }
        }
        if (sym.kind === "function" || sym.kind === "method" || sym.kind === "class") {
          const symCallers = await this.findCallers(sym.name, targetFilePath, 10);
          for (const c of symCallers.callers) {
            if (
              !callers.some(
                (existing) => existing.path === c.path && existing.callLine === c.callLine,
              )
            ) {
              callers.push(c);
            }
          }
        }
      }
    }

    const dependentFiles = [...dependentFilesSet].sort();

    // 4. Affected Tests Discovery
    const affectedTestsSet = new Set<string>();
    for (const dep of dependentFiles) {
      if (isTestFile(dep)) {
        affectedTestsSet.add(dep);
      }
    }

    if (resolvedPath) {
      const stem = resolvedPath.slice(resolvedPath.lastIndexOf("/") + 1).replace(/\.[^/.]+$/, "");

      for (const file of allFiles) {
        if (!isTestFile(file)) continue;
        const lowerFile = file.toLowerCase();
        const lowerStem = stem.toLowerCase();
        if (
          lowerFile.includes(`${lowerStem}.test.`) ||
          lowerFile.includes(`${lowerStem}.spec.`) ||
          lowerFile.includes(`test_${lowerStem}.`) ||
          lowerFile.includes(`${lowerStem}test.`) ||
          lowerFile.includes(`${lowerStem}_test.`) ||
          lowerFile.endsWith(`/${lowerStem}.test.ts`) ||
          lowerFile.endsWith(`/${lowerStem}.test.js`) ||
          lowerFile.endsWith(`/${lowerStem}_test.go`) ||
          lowerFile.endsWith(`/${lowerStem}_test.rs`)
        ) {
          affectedTestsSet.add(file);
        }
      }
    }
    const affectedTests = [...affectedTestsSet].sort();

    // 5. Blast Radius & Risk Assessment
    const totalImpact = dependentFiles.length + callers.length;
    const riskLevel: "low" | "medium" | "high" =
      totalImpact > 10 || dependentFiles.length > 5
        ? "high"
        : totalImpact > 3 || dependentFiles.length > 1
          ? "medium"
          : "low";

    const summaryParts: string[] = [
      `Target "${target}" (${targetKind}${resolvedPath ? `: ${resolvedPath}` : ""}) has ${riskLevel.toUpperCase()} blast radius.`,
      `Direct dependents: ${dependentFiles.length} file(s). Known caller sites: ${callers.length}.`,
    ];
    if (affectedTests.length > 0) {
      summaryParts.push(`Recommended test suite: ${affectedTests.join(", ")}`);
    } else {
      summaryParts.push("No direct test files found; verify impacted callers.");
    }

    return {
      target,
      targetKind,
      ...(resolvedPath ? { resolvedPath } : {}),
      definitions,
      dependentFiles,
      callers,
      affectedTests,
      riskLevel,
      summary: summaryParts.join("\n"),
    };
  }

  async astQuery(options: AstQueryOptions): Promise<SymbolHit[]> {
    const byExpert = await this.byExpert();
    const hits: SymbolHit[] = [];
    const limit = options.limit ?? 50;

    const prefix = options.pathPrefix;
    for (const { expert, files } of byExpert) {
      const targetFiles = prefix ? files.filter((f) => f.startsWith(prefix)) : files;

      if (targetFiles.length === 0) continue;

      // All symbols, then the filters, then the limit (before, the limit came first and a match
      // after the first limit*4 symbols was lost).
      const expertSymbols = expert.findSymbols(targetFiles, "", false, Number.MAX_SAFE_INTEGER);

      for (const sym of expertSymbols) {
        if (options.kind !== undefined && sym.kind.toLowerCase() !== options.kind.toLowerCase()) {
          continue;
        }
        if (options.exported !== undefined && sym.exported !== options.exported) {
          continue;
        }
        if (options.container !== undefined) {
          if (!sym.container?.toLowerCase().includes(options.container.toLowerCase())) {
            continue;
          }
        }
        if (options.namePattern !== undefined) {
          if (!matchPattern(sym.name, options.namePattern)) {
            continue;
          }
        }
        hits.push(sym);
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  /** File nodes under `dir` (relative, default: the root). Unchanged files come from the cache. */
  async repoMap(dir = ""): Promise<FileNode[]> {
    const cache = await this.loadCache();
    const next: GraphCache = { version: GRAPH_VERSION, files: {} };
    const nodes: FileNode[] = [];
    const prefix = dir.replace(/^\.?\/?/, "").replace(/\/?$/, dir === "" || dir === "." ? "" : "/");
    for (const { expert, files } of await this.byExpert()) {
      for (const path of files) {
        // A file deleted or renamed since the listing is left out, not an error.
        const content = await readFile(join(this.root, path), "utf8").catch(() => undefined);
        if (content === undefined) continue;
        const hash = createHash("sha256").update(content).digest("hex");
        const cached = cache.files[path];
        const node = cached?.hash === hash ? cached.node : expert.summarise(path, content);
        next.files[path] = { hash, node };
        if (path.startsWith(prefix)) nodes.push(node);
      }
    }
    await this.saveCache(next);
    return nodes.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async ensurePlugins(): Promise<
    Array<{ plugin: LanguagePlugin; expert: LanguageExpert }>
  > {
    // One load, also for parallel read-only tool calls (before, each built its own experts).
    this.pluginLoading ??= this.loadPlugins();
    return this.pluginLoading;
  }

  private async loadPlugins(): Promise<Array<{ plugin: LanguagePlugin; expert: LanguageExpert }>> {
    if (this.pluginExperts) return this.pluginExperts;

    let plugins: LanguagePlugin[];
    if (this.customPlugins) {
      plugins = [];
      for (let i = 0; i < this.customPlugins.length; i++) {
        const item = this.customPlugins[i];
        if (typeof item === "function") {
          const sample = await item(this.root);
          plugins.push({
            id: sample.id || `expert-${i}`,
            extensions: sample.extensions,
            source: "built-in",
            factory: () => sample,
          });
        } else if (item) {
          plugins.push(item);
        }
      }
    } else if (this.home === undefined) {
      plugins = [...BUILTIN_PLUGINS];
    } else {
      const trust = this.trust ?? (await TrustStore.open(this.home));
      const discovered = await discoverPlugins({
        root: this.root,
        home: this.home,
        trust,
        includeBuiltins: true,
      });
      this.discoveryWarnings = discovered.warnings;
      plugins = discovered.plugins;
    }

    const pairs: Array<{ plugin: LanguagePlugin; expert: LanguageExpert }> = [];
    for (const plugin of plugins) {
      const expert = await plugin.factory(this.root);
      pairs.push({ plugin, expert });
    }
    this.pluginExperts = pairs;
    return pairs;
  }

  /** Indexable files, grouped by the expert that handles their extension. */
  private async byExpert(): Promise<
    Array<{ plugin: LanguagePlugin; expert: LanguageExpert; files: string[] }>
  > {
    const pairs = await this.ensurePlugins();
    const all = await listFiles(this.root, "**/*", this.root);
    const groups = pairs.map(({ plugin, expert }) => ({
      plugin,
      expert,
      files: [] as string[],
    }));
    let count = 0;
    for (const absolute of all.sort()) {
      const path = absolute
        .slice(this.root.length + 1)
        .split("\\")
        .join("/");
      if (path.startsWith(".garuda/") || isSensitive(path) || this.hidden(path)) continue;
      const ext = extname(path);
      const group = groups.find((g) => g.expert.extensions.includes(ext));
      if (group === undefined) continue;
      const info = await stat(absolute).catch(() => undefined);
      if (info === undefined || info.size > MAX_FILE_BYTES) continue;
      group.files.push(path);
      if (++count >= MAX_FILES) break;
    }
    return groups;
  }

  private async loadCache(): Promise<GraphCache> {
    try {
      const cache = JSON.parse(await readFile(join(this.root, GRAPH_FILE), "utf8")) as GraphCache;
      if (cache.version === GRAPH_VERSION) return cache;
    } catch {
      // No cache yet, or a broken one: build it again.
    }
    return { version: GRAPH_VERSION, files: {} };
  }

  /** Best effort (0.14, review): a read-only checkout gives the map without a cache, not an error. */
  private async saveCache(cache: GraphCache): Promise<void> {
    const path = join(this.root, GRAPH_FILE);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(cache));
    } catch {
      // The next call builds the map again.
    }
  }
}

function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.endsWith("test.java") ||
    lower.endsWith("tests.java") ||
    lower.endsWith("_test.go") ||
    lower.endsWith("_test.rs") ||
    lower.startsWith("test_") ||
    lower.includes("/test_")
  );
}

function matchPattern(name: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const regex = new RegExp(`^${escaped}$`, "i");
    return regex.test(name);
  }
  return name.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * The definition that holds a call (G08): in Python by indentation, in brace languages only when the
 * call is inside a body (top-level code is "<module>"), then the nearest callable above it.
 */
function enclosingSymbol(
  path: string,
  content: string,
  lines: readonly string[],
  line: number,
  callables: readonly SymbolHit[],
): SymbolHit | undefined {
  if (path.endsWith(".py")) {
    const at = pythonEnclosingLine(lines, line);
    return at === undefined ? undefined : callables.find((s) => s.line === at);
  }
  if (content !== "" && braceDepthAt(content, line) === 0) return undefined;
  return callables.filter((s) => s.line <= line).sort((a, b) => b.line - a.line)[0];
}
