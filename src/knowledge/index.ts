import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { isSensitive } from "../permissions/sensitive.js";
import { listFiles } from "../tools/files.js";
import type { FileNode, LanguageExpert, ReferenceHit, SymbolHit } from "./types.js";
import { createTypeScriptExpert } from "./typescript.js";

export type { FileNode, ReferenceHit, SymbolHit } from "./types.js";

export const GRAPH_FILE = ".garuda/index/code-graph.json";
const GRAPH_VERSION = 1;
const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 1024 * 1024;

type ExpertFactory = (root: string) => Promise<LanguageExpert>;

/** Experts that Garuda ships. Other languages add their own factory here. */
export const DEFAULT_EXPERTS: readonly ExpertFactory[] = [createTypeScriptExpert];

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
  private experts: LanguageExpert[] | undefined;

  constructor(
    readonly root: string,
    private readonly factories: readonly ExpertFactory[] = DEFAULT_EXPERTS,
  ) {}

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

  /** File nodes under `dir` (relative, default: the root). Unchanged files come from the cache. */
  async repoMap(dir = ""): Promise<FileNode[]> {
    const cache = await this.loadCache();
    const next: GraphCache = { version: GRAPH_VERSION, files: {} };
    const nodes: FileNode[] = [];
    const prefix = dir.replace(/^\.?\/?/, "").replace(/\/?$/, dir === "" || dir === "." ? "" : "/");
    for (const { expert, files } of await this.byExpert()) {
      for (const path of files) {
        const content = await readFile(join(this.root, path), "utf8");
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

  /** Indexable files, grouped by the expert that handles their extension. */
  private async byExpert(): Promise<Array<{ expert: LanguageExpert; files: string[] }>> {
    this.experts ??= await Promise.all(this.factories.map((make) => make(this.root)));
    const all = await listFiles(this.root, "**/*", this.root);
    const groups = this.experts.map((expert) => ({ expert, files: [] as string[] }));
    let count = 0;
    for (const absolute of all.sort()) {
      const path = absolute
        .slice(this.root.length + 1)
        .split("\\")
        .join("/");
      if (path.startsWith(".garuda/") || isSensitive(path)) continue;
      const group = groups.find((g) => g.expert.extensions.includes(extname(path)));
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

  private async saveCache(cache: GraphCache): Promise<void> {
    const path = join(this.root, GRAPH_FILE);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(cache));
  }
}
