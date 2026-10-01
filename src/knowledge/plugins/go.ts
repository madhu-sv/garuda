import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExportEntry, FileNode, LanguageExpert, ReferenceHit, SymbolHit } from "../types.js";

const GO_EXTENSIONS: readonly string[] = [".go"];

export interface ParsedGoFile {
  imports: string[];
  exports: ExportEntry[];
  symbols: SymbolHit[];
  lines: string[];
}

export class GoExpert implements LanguageExpert {
  readonly id = "go";
  readonly extensions = GO_EXTENSIONS;

  private cache = new Map<string, { mtimeMs: number; size: number; parsed: ParsedGoFile }>();

  constructor(private readonly root: string) {}

  summarise(path: string, content: string): FileNode {
    const parsed = parseGo(path, content);
    return {
      path,
      exports: parsed.exports,
      imports: parsed.imports,
    };
  }

  findSymbols(files: readonly string[], query: string, exact: boolean, limit: number): SymbolHit[] {
    const hits: SymbolHit[] = [];
    const lowerQuery = query.toLowerCase();

    for (const relPath of files) {
      if (!GO_EXTENSIONS.some((ext) => relPath.endsWith(ext))) continue;
      const parsed = this.getOrParse(relPath);
      if (!parsed) continue;

      for (const sym of parsed.symbols) {
        const matches = exact ? sym.name === query : sym.name.toLowerCase().includes(lowerQuery);
        if (matches) {
          hits.push(sym);
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }

  findReferences(
    files: readonly string[],
    name: string,
    inFile: string | undefined,
    limit: number,
  ): {
    definition: SymbolHit | undefined;
    references: ReferenceHit[];
    candidates: SymbolHit[];
  } {
    const candidates = this.findSymbols(files, name, true, 50);
    const definition = inFile
      ? (candidates.find((c) => c.path === inFile) ?? candidates[0])
      : candidates[0];

    if (!definition) {
      return { definition: undefined, references: [], candidates: [] };
    }

    const references: ReferenceHit[] = [];
    const identRegex = new RegExp(`\\b${escapeRegex(name)}\\b`, "g");

    for (const relPath of files) {
      if (!GO_EXTENSIONS.some((ext) => relPath.endsWith(ext))) continue;
      const parsed = this.getOrParse(relPath);
      if (!parsed) continue;

      for (let lineIdx = 0; lineIdx < parsed.lines.length; lineIdx++) {
        const rawLine = parsed.lines[lineIdx] ?? "";
        const commentIdx = rawLine.indexOf("//");
        const codeLine = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;

        identRegex.lastIndex = 0;
        if (identRegex.test(codeLine)) {
          const lineNum = lineIdx + 1;
          const isDef = relPath === definition.path && lineNum === definition.line;
          references.push({
            path: relPath,
            line: lineNum,
            text: rawLine.trim(),
            isDefinition: isDef,
          });
          if (references.length >= limit) break;
        }
      }
      if (references.length >= limit) break;
    }

    references.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    return { definition, references, candidates };
  }

  private getOrParse(relPath: string): ParsedGoFile | undefined {
    const absPath = isAbsolute(relPath) ? relPath : `${this.root}/${relPath}`.replace(/\/+/g, "/");
    try {
      const st = statSync(absPath);
      const cached = this.cache.get(relPath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        return cached.parsed;
      }
      const content = readFileSync(absPath, "utf8");
      const parsed = parseGo(relPath, content);
      this.cache.set(relPath, { mtimeMs: st.mtimeMs, size: st.size, parsed });
      return parsed;
    } catch {
      return undefined;
    }
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGoExported(name: string): boolean {
  if (name.length === 0) return false;
  const first = name.charCodeAt(0);
  return first >= 65 && first <= 90; // 'A' <= first <= 'Z'
}

export function parseGo(relPath: string, content: string): ParsedGoFile {
  const lines = content.split("\n");
  const imports: string[] = [];
  const symbols: SymbolHit[] = [];
  const exports: ExportEntry[] = [];

  let inMultiLineImport = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const commentIdx = rawLine.indexOf("//");
    const code = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
    const trimmed = code.trim();

    if (trimmed.length === 0) continue;

    // 1. Imports
    if (inMultiLineImport) {
      if (trimmed === ")") {
        inMultiLineImport = false;
      } else {
        const match = trimmed.match(/(?:[a-zA-Z0-9_.]+\s+)?"([^"]+)"/);
        if (match?.[1]) imports.push(match[1]);
      }
      continue;
    }

    if (trimmed === "import (") {
      inMultiLineImport = true;
      continue;
    }

    const singleImport = trimmed.match(/^import\s+(?:[a-zA-Z0-9_.]+\s+)?"([^"]+)"/);
    if (singleImport?.[1]) {
      imports.push(singleImport[1]);
      continue;
    }

    // 2. Package
    const packageMatch = trimmed.match(/^package\s+([a-zA-Z0-9_]+)/);
    if (packageMatch?.[1]) {
      const pkgName = packageMatch[1];
      symbols.push({
        name: pkgName,
        kind: "package",
        path: relPath,
        line: i + 1,
        exported: true,
      });
      continue;
    }

    // 3. Types: struct, interface, alias
    // e.g. type OrderService struct { or type Handler interface { or type ID string
    const typeMatch = trimmed.match(
      /^type\s+([a-zA-Z0-9_]+)\s+(struct|interface|[a-zA-Z0-9_.*[\]]+)/,
    );
    if (typeMatch?.[1] && typeMatch[2]) {
      const name = typeMatch[1];
      const kindRaw = typeMatch[2];
      const kind = kindRaw === "struct" ? "struct" : kindRaw === "interface" ? "interface" : "type";
      const exported = isGoExported(name);

      symbols.push({
        name,
        kind,
        path: relPath,
        line: i + 1,
        exported,
      });

      if (exported) {
        exports.push({ name, kind, line: i + 1 });
      }
      continue;
    }

    // 4. Methods with receiver: func (r *OrderService) CreateOrder(...)
    const methodMatch = trimmed.match(
      /^func\s*\(\s*(?:[a-zA-Z0-9_]+\s+)?\*?([a-zA-Z0-9_]+)\s*\)\s*([a-zA-Z0-9_]+)\s*\(/,
    );
    if (methodMatch?.[1] && methodMatch[2]) {
      const container = methodMatch[1];
      const name = methodMatch[2];
      const exported = isGoExported(name);

      symbols.push({
        name,
        kind: "method",
        path: relPath,
        line: i + 1,
        container,
        exported,
      });

      if (exported) {
        exports.push({ name, kind: "method", line: i + 1 });
      }
      continue;
    }

    // 5. Standard Functions: func CreateOrder(...)
    const funcMatch = trimmed.match(/^func\s+([a-zA-Z0-9_]+)\s*(?:<[^>]+>)?\s*\(/);
    if (funcMatch?.[1]) {
      const name = funcMatch[1];
      const exported = isGoExported(name);

      symbols.push({
        name,
        kind: "function",
        path: relPath,
        line: i + 1,
        exported,
      });

      if (exported) {
        exports.push({ name, kind: "function", line: i + 1 });
      }
      continue;
    }

    // 6. Const & Var: const MaxRetry = 5 or var ErrNotFound = ...
    const constVarMatch = trimmed.match(
      /^(?:const|var)\s+([a-zA-Z0-9_]+)(?:\s+[a-zA-Z0-9_.*[\]]+)?\s*=/,
    );
    if (constVarMatch?.[1]) {
      const name = constVarMatch[1];
      const exported = isGoExported(name);

      symbols.push({
        name,
        kind: trimmed.startsWith("const") ? "constant" : "variable",
        path: relPath,
        line: i + 1,
        exported,
      });

      if (exported) {
        exports.push({
          name,
          kind: trimmed.startsWith("const") ? "constant" : "variable",
          line: i + 1,
        });
      }
    }
  }

  return { imports, exports, symbols, lines };
}

export function createGoExpert(root: string): LanguageExpert {
  return new GoExpert(root);
}
