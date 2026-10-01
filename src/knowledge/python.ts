import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExportEntry, FileNode, LanguageExpert, ReferenceHit, SymbolHit } from "./types.js";

export const PYTHON_EXTENSIONS = [".py", ".pyw"] as const;

export async function createPythonExpert(root: string): Promise<LanguageExpert> {
  return new PythonExpert(root);
}

interface ParsedPythonFile {
  exports: ExportEntry[];
  imports: string[];
  symbols: SymbolHit[];
  lines: string[];
}

export class PythonExpert implements LanguageExpert {
  readonly id = "python";
  readonly extensions = PYTHON_EXTENSIONS;
  private readonly cache = new Map<
    string,
    { mtimeMs: number; size: number; parsed: ParsedPythonFile }
  >();

  constructor(private readonly root: string) {}

  summarise(path: string, content: string): FileNode {
    const parsed = parsePython(path, content);
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
      if (!PYTHON_EXTENSIONS.some((ext) => relPath.endsWith(ext))) continue;
      const parsed = this.getOrParse(relPath);
      if (!parsed) continue;

      for (const sym of parsed.symbols) {
        const matches = exact ? sym.name === query : sym.name.toLowerCase().includes(lowerQuery);
        if (matches) {
          hits.push(sym);
          if (hits.length >= limit * 2) break;
        }
      }
      if (hits.length >= limit * 2) break;
    }

    return hits
      .sort((a, b) => Number(b.exported) - Number(a.exported) || a.path.localeCompare(b.path))
      .slice(0, limit);
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
    const candidates = this.findSymbols(files, name, true, 20).filter(
      (c) => inFile === undefined || c.path === inFile,
    );
    const definition = candidates[0];
    if (definition === undefined) {
      return { definition: undefined, references: [], candidates };
    }

    const references: ReferenceHit[] = [];
    // Token-boundary regex to match word occurrences
    const identRegex = new RegExp(`\\b${escapeRegex(name)}\\b`, "g");

    for (const relPath of files) {
      if (!PYTHON_EXTENSIONS.some((ext) => relPath.endsWith(ext))) continue;
      const parsed = this.getOrParse(relPath);
      if (!parsed) continue;

      for (let lineIdx = 0; lineIdx < parsed.lines.length; lineIdx++) {
        const rawLine = parsed.lines[lineIdx] ?? "";
        // Strip comments for matching
        const commentIdx = rawLine.indexOf("#");
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

  private getOrParse(relPath: string): ParsedPythonFile | undefined {
    const absPath = isAbsolute(relPath) ? relPath : `${this.root}/${relPath}`.replace(/\/+/g, "/");
    try {
      const st = statSync(absPath);
      const cached = this.cache.get(relPath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        return cached.parsed;
      }
      const content = readFileSync(absPath, "utf8");
      const parsed = parsePython(relPath, content);
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

export function parsePython(relPath: string, content: string): ParsedPythonFile {
  const lines = content.split("\n");
  const imports: string[] = [];
  const symbols: SymbolHit[] = [];
  const exports: ExportEntry[] = [];

  // Track __all__ if defined
  let hasExplicitAll = false;
  const explicitExports = new Set<string>();

  // Scope stack: tracks indentation and class names
  interface Scope {
    indent: number;
    kind: "class" | "function";
    name: string;
  }
  const scopeStack: Scope[] = [];

  let inMultiLineString: "'" | '"' | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check multi-line string toggle
    if (inMultiLineString) {
      const closeDelim = inMultiLineString.repeat(3);
      if (line.includes(closeDelim)) {
        inMultiLineString = null;
      }
      continue;
    }

    if (trimmed.startsWith('"""') && !trimmed.slice(3).includes('"""')) {
      inMultiLineString = '"';
      continue;
    }
    if (trimmed.startsWith("'''") && !trimmed.slice(3).includes("'''")) {
      inMultiLineString = "'";
      continue;
    }

    // Ignore comment lines
    if (trimmed.startsWith("#")) continue;

    // Calculate line indent
    const indentMatch = line.match(/^([ \t]*)/);
    const indent = indentMatch ? (indentMatch[1]?.replace(/\t/g, "    ").length ?? 0) : 0;

    // Pop scopes that are deeper or equal to current indentation
    while (scopeStack.length > 0 && (scopeStack[scopeStack.length - 1]?.indent ?? 0) >= indent) {
      scopeStack.pop();
    }

    const currentContainer = scopeStack.findLast((s) => s.kind === "class")?.name;

    // 1. Imports
    // e.g. import os, sys; import math as m
    const importMatch = trimmed.match(/^import\s+([a-zA-Z0-9_.,\s]+)/);
    if (importMatch?.[1]) {
      const parts = importMatch[1].split(",");
      for (const part of parts) {
        const modName = part
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (modName) imports.push(modName);
      }
      continue;
    }

    // e.g. from os.path import join; from .utils import foo
    const fromImportMatch = trimmed.match(/^from\s+([a-zA-Z0-9_.]+)\s+import/);
    if (fromImportMatch?.[1]) {
      imports.push(fromImportMatch[1]);
      continue;
    }

    // 2. __all__ = ["foo", "bar"]
    const allMatch = trimmed.match(/^__all__\s*=\s*\[(.*?)\]/);
    if (allMatch?.[1]) {
      hasExplicitAll = true;
      const items = allMatch[1].match(/['"]([a-zA-Z0-9_]+)['"]/g);
      if (items) {
        for (const item of items) {
          explicitExports.add(item.replace(/['"]/g, ""));
        }
      }
    }

    // 3. Classes
    // e.g. class MyService(Base):
    const classMatch = trimmed.match(/^class\s+([a-zA-Z0-9_]+)(\s*\(.*?\))?\s*:/);
    if (classMatch?.[1]) {
      const name = classMatch[1];
      const isTopLevel = scopeStack.length === 0;
      const isExported = !name.startsWith("_");

      symbols.push({
        name,
        kind: "class",
        path: relPath,
        line: i + 1,
        ...(currentContainer ? { container: currentContainer } : {}),
        exported: isExported,
      });

      if (isTopLevel && isExported) {
        exports.push({ name, kind: "class", line: i + 1 });
      }

      scopeStack.push({ indent, kind: "class", name });
      continue;
    }

    // 4. Functions & Methods
    // e.g. def func(...): or async def async_func(...):
    const funcMatch = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(/);
    if (funcMatch?.[1]) {
      const name = funcMatch[1];
      const isMethod = currentContainer !== undefined;
      const isTopLevel = scopeStack.length === 0;
      const isExported = !name.startsWith("_");

      symbols.push({
        name,
        kind: isMethod ? "method" : "function",
        path: relPath,
        line: i + 1,
        ...(currentContainer ? { container: currentContainer } : {}),
        exported: isExported,
      });

      if (isTopLevel && isExported) {
        exports.push({ name, kind: "function", line: i + 1 });
      }

      scopeStack.push({ indent, kind: "function", name });
      continue;
    }

    // 5. Top-level variables / constants
    // e.g. DEFAULT_TIMEOUT = 100 or API_URL: str = "http"
    if (scopeStack.length === 0) {
      const varMatch = trimmed.match(/^([A-Z0-9_]+)\s*(?::\s*[^=]+)?\s*=/);
      if (varMatch?.[1] && !varMatch[1].startsWith("_")) {
        const name = varMatch[1];
        symbols.push({
          name,
          kind: "variable",
          path: relPath,
          line: i + 1,
          exported: true,
        });
        exports.push({ name, kind: "variable", line: i + 1 });
      }
    }
  }

  // If explicit __all__ was defined, refine exported flag on symbols and exports list
  let finalExports = exports;
  if (hasExplicitAll) {
    for (const sym of symbols) {
      if (sym.container === undefined) {
        sym.exported = explicitExports.has(sym.name);
      }
    }
    finalExports = exports.filter((e) => explicitExports.has(e.name));
  }

  return {
    exports: finalExports,
    imports: [...new Set(imports)],
    symbols,
    lines,
  };
}
