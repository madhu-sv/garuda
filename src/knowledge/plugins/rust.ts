import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExportEntry, FileNode, LanguageExpert, ReferenceHit, SymbolHit } from "../types.js";

const RUST_EXTENSIONS: readonly string[] = [".rs"];

export interface ParsedRustFile {
  imports: string[];
  exports: ExportEntry[];
  symbols: SymbolHit[];
  lines: string[];
}

export class RustExpert implements LanguageExpert {
  readonly id = "rust";
  readonly extensions = RUST_EXTENSIONS;

  private cache = new Map<string, { mtimeMs: number; size: number; parsed: ParsedRustFile }>();

  constructor(private readonly root: string) {}

  summarise(path: string, content: string): FileNode {
    const parsed = parseRust(path, content);
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
      if (!RUST_EXTENSIONS.some((ext) => relPath.endsWith(ext))) continue;
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
      if (!RUST_EXTENSIONS.some((ext) => relPath.endsWith(ext))) continue;
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

  private getOrParse(relPath: string): ParsedRustFile | undefined {
    const absPath = isAbsolute(relPath) ? relPath : `${this.root}/${relPath}`.replace(/\/+/g, "/");
    try {
      const st = statSync(absPath);
      const cached = this.cache.get(relPath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        return cached.parsed;
      }
      const content = readFileSync(absPath, "utf8");
      const parsed = parseRust(relPath, content);
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

interface ContainerScope {
  name: string;
  braceDepth: number;
}

export function parseRust(relPath: string, content: string): ParsedRustFile {
  const lines = content.split("\n");
  const imports: string[] = [];
  const symbols: SymbolHit[] = [];
  const exports: ExportEntry[] = [];

  const implStack: ContainerScope[] = [];
  let currentBraceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const commentIdx = rawLine.indexOf("//");
    const code = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
    const trimmed = code.trim();

    const openBraces = (code.match(/\{/g) ?? []).length;
    const closeBraces = (code.match(/\}/g) ?? []).length;

    if (trimmed.length === 0) {
      currentBraceDepth += openBraces - closeBraces;
      continue;
    }

    // 1. Imports: use path::to::Module; or pub use ...
    const useMatch = trimmed.match(/^(?:pub(?:\([^)]+\))?\s+)?use\s+([^;]+);/);
    if (useMatch?.[1]) {
      const path = useMatch[1].trim();
      imports.push(path);
      currentBraceDepth += openBraces - closeBraces;
      continue;
    }

    const isPub = /^(?:pub(?:\([^)]+\))?)\s+/.test(trimmed);

    // 2. Mod declaration: mod foo; or pub mod foo;
    const modMatch = trimmed.match(/^(?:pub(?:\([^)]+\))?\s+)?mod\s+([a-zA-Z0-9_]+)\s*;/);
    if (modMatch?.[1]) {
      const name = modMatch[1];
      symbols.push({
        name,
        kind: "module",
        path: relPath,
        line: i + 1,
        exported: isPub,
      });
      if (isPub) exports.push({ name, kind: "module", line: i + 1 });
      currentBraceDepth += openBraces - closeBraces;
      continue;
    }

    // 3. Impl block: impl Type { or impl Trait for Type {
    const implMatch = trimmed.match(
      /^impl(?:<[^>]+>)?\s+(?:[a-zA-Z0-9_:]+\s+for\s+)?([a-zA-Z0-9_]+)/,
    );
    if (implMatch?.[1] && trimmed.includes("{")) {
      const typeName = implMatch[1];
      implStack.push({
        name: typeName,
        braceDepth: currentBraceDepth + openBraces,
      });
      currentBraceDepth += openBraces - closeBraces;
      continue;
    }

    // 4. Struct, Enum, Trait, Type declarations
    const typeMatch = trimmed.match(
      /^(?:pub(?:\([^)]+\))?\s+)?(struct|enum|trait|type)\s+([a-zA-Z0-9_]+)/,
    );
    if (typeMatch?.[1] && typeMatch[2]) {
      const kind = typeMatch[1];
      const name = typeMatch[2];
      symbols.push({
        name,
        kind,
        path: relPath,
        line: i + 1,
        exported: isPub,
      });
      if (isPub) exports.push({ name, kind, line: i + 1 });
      currentBraceDepth += openBraces - closeBraces;
      continue;
    }

    // 5. Functions & Methods: fn name(...) or pub fn name(...) or async fn name(...)
    const fnMatch = trimmed.match(
      /^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]+"\s+)?fn\s+([a-zA-Z0-9_]+)\s*(?:<[^>]+>)?\s*\(/,
    );
    if (fnMatch?.[1]) {
      const name = fnMatch[1];
      const currentContainer = implStack[implStack.length - 1]?.name;
      const kind = currentContainer ? "method" : "function";

      symbols.push({
        name,
        kind,
        path: relPath,
        line: i + 1,
        ...(currentContainer ? { container: currentContainer } : {}),
        exported: isPub,
      });

      if (isPub && !currentContainer) {
        exports.push({ name, kind, line: i + 1 });
      }
    }

    // 6. Const & Static: pub const MAX: u32 = 100;
    const constMatch = trimmed.match(
      /^(?:pub(?:\([^)]+\))?\s+)?(const|static)\s+([a-zA-Z0-9_]+)\s*:/,
    );
    if (constMatch?.[1] && constMatch[2]) {
      const kind = constMatch[1];
      const name = constMatch[2];
      symbols.push({
        name,
        kind: kind === "const" ? "constant" : "variable",
        path: relPath,
        line: i + 1,
        exported: isPub,
      });
      if (isPub) exports.push({ name, kind: "constant", line: i + 1 });
    }

    // 7. Macro rules: macro_rules! name {
    const macroMatch = trimmed.match(/^macro_rules!\s+([a-zA-Z0-9_]+)/);
    if (macroMatch?.[1]) {
      const name = macroMatch[1];
      symbols.push({
        name,
        kind: "macro",
        path: relPath,
        line: i + 1,
        exported: true,
      });
      exports.push({ name, kind: "macro", line: i + 1 });
    }

    currentBraceDepth += openBraces - closeBraces;

    // Pop impl scopes when exiting their brace depth
    while (
      implStack.length > 0 &&
      currentBraceDepth < (implStack[implStack.length - 1]?.braceDepth ?? 0)
    ) {
      implStack.pop();
    }
  }

  return { imports, exports, symbols, lines };
}

export function createRustExpert(root: string): LanguageExpert {
  return new RustExpert(root);
}
