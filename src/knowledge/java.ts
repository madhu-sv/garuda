import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExportEntry, FileNode, LanguageExpert, ReferenceHit, SymbolHit } from "./types.js";

export const JAVA_EXTENSIONS = [".java"] as const;

export async function createJavaExpert(root: string): Promise<LanguageExpert> {
  return new JavaExpert(root);
}

interface ParsedJavaFile {
  exports: ExportEntry[];
  imports: string[];
  symbols: SymbolHit[];
  lines: string[];
}

export class JavaExpert implements LanguageExpert {
  readonly id = "java";
  readonly extensions = JAVA_EXTENSIONS;
  private readonly cache = new Map<
    string,
    { mtimeMs: number; size: number; parsed: ParsedJavaFile }
  >();

  constructor(private readonly root: string) {}

  summarise(path: string, content: string): FileNode {
    const parsed = parseJava(path, content);
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
      if (!JAVA_EXTENSIONS.some((ext) => relPath.endsWith(ext))) continue;
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
    const identRegex = new RegExp(`\\b${escapeRegex(name)}\\b`, "g");

    for (const relPath of files) {
      if (!JAVA_EXTENSIONS.some((ext) => relPath.endsWith(ext))) continue;
      const parsed = this.getOrParse(relPath);
      if (!parsed) continue;

      for (let lineIdx = 0; lineIdx < parsed.lines.length; lineIdx++) {
        const rawLine = parsed.lines[lineIdx] ?? "";
        // Strip single line comments
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

  private getOrParse(relPath: string): ParsedJavaFile | undefined {
    const absPath = isAbsolute(relPath) ? relPath : `${this.root}/${relPath}`.replace(/\/+/g, "/");
    try {
      const st = statSync(absPath);
      const cached = this.cache.get(relPath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        return cached.parsed;
      }
      const content = readFileSync(absPath, "utf8");
      const parsed = parseJava(relPath, content);
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

export function parseJava(relPath: string, content: string): ParsedJavaFile {
  const lines = content.split("\n");
  const imports: string[] = [];
  const symbols: SymbolHit[] = [];
  const exports: ExportEntry[] = [];

  let inBlockComment = false;

  interface ContainerScope {
    name: string;
    braceDepth: number;
    kind: string;
  }
  const containerStack: ContainerScope[] = [];
  let currentBraceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Handle block comments /* ... */
    if (inBlockComment) {
      if (trimmed.includes("*/")) {
        inBlockComment = false;
      }
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) {
        inBlockComment = true;
      }
      continue;
    }

    // Ignore single line comments
    if (trimmed.startsWith("//")) continue;

    // Count brace depth changes
    const openBraces = (trimmed.match(/\{/g) || []).length;
    const closeBraces = (trimmed.match(/\}/g) || []).length;

    // 1. Imports
    // e.g. import com.example.model.User; import static ...;
    const importMatch = trimmed.match(/^import\s+(?:static\s+)?([a-zA-Z0-9_.*]+)\s*;/);
    if (importMatch?.[1]) {
      imports.push(importMatch[1]);
      continue;
    }

    const currentContainer = containerStack[containerStack.length - 1]?.name;

    // 2. Class, Interface, Record, Enum Declarations
    // e.g. [public] [final] class MyClass [extends ...] [implements ...] {
    const typeMatch = trimmed.match(
      /(?:public|protected|private|static|final|abstract|\s)*\b(class|interface|record|enum)\s+([a-zA-Z0-9_]+)/,
    );
    if (typeMatch?.[1] && typeMatch[2]) {
      const kind = typeMatch[1];
      const name = typeMatch[2];
      const isPublicOrProtected = /\b(public|protected)\b/.test(trimmed);
      const isExported = isPublicOrProtected || containerStack.length === 0;

      symbols.push({
        name,
        kind,
        path: relPath,
        line: i + 1,
        ...(currentContainer ? { container: currentContainer } : {}),
        exported: isExported,
      });

      if (isExported) {
        exports.push({ name, kind, line: i + 1 });
      }

      containerStack.push({
        name,
        braceDepth: currentBraceDepth + openBraces,
        kind,
      });

      currentBraceDepth += openBraces - closeBraces;
      continue;
    }

    // 3. Methods & Constructors (only valid inside class/interface/record/enum container)
    // e.g. public void doSomething(...) { or public MyClass(...) {
    if (currentContainer !== undefined && !trimmed.includes("=") && !trimmed.startsWith("throw ")) {
      const methodMatch = trimmed.match(
        /(?:public|protected|private|static|final|synchronized|abstract|\s)*(?:<[^>]+>\s+)?([a-zA-Z0-9_<>[\], ]+)\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*(?:throws\s+[^{]+)?\s*[{;]/,
      );
      if (methodMatch?.[1] && methodMatch[2]) {
        const returnTypeOrName = methodMatch[1].trim();
        const methodName = methodMatch[2].trim();

        // Avoid matching control structures and statements
        const controlKeywords = new Set([
          "if",
          "while",
          "for",
          "switch",
          "catch",
          "return",
          "new",
          "throw",
          "assert",
          "super",
          "this",
          "import",
          "package",
        ]);

        if (
          !controlKeywords.has(methodName) &&
          !controlKeywords.has(returnTypeOrName) &&
          !returnTypeOrName.includes("new ") &&
          !methodName.includes(".")
        ) {
          const isConstructor = methodName === currentContainer;
          const kind = isConstructor ? "constructor" : "method";
          const isPublicOrProtected = /\b(public|protected)\b/.test(trimmed);

          symbols.push({
            name: methodName,
            kind,
            path: relPath,
            line: i + 1,
            container: currentContainer,
            exported: isPublicOrProtected,
          });
        }
      }
    }

    // Adjust brace depth
    currentBraceDepth += openBraces - closeBraces;

    // Pop containers when exiting their braces
    while (
      containerStack.length > 0 &&
      currentBraceDepth < (containerStack[containerStack.length - 1]?.braceDepth ?? 0)
    ) {
      containerStack.pop();
    }
  }

  return {
    exports,
    imports: [...new Set(imports)],
    symbols,
    lines,
  };
}
