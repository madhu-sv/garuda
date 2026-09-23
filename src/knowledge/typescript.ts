import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type TS from "ts6";
import type { ExportEntry, FileNode, LanguageExpert, ReferenceHit, SymbolHit } from "./types.js";

/**
 * The TypeScript/JavaScript expert. It uses the TypeScript 6 language service (the last
 * compiler written in JavaScript, so it fits in the single `garuda` binary; TypeScript 7 is
 * a native binary). It understands imports, re-exports and renames, which grep cannot.
 * It loads on first use, so startup stays fast (N3).
 */
export async function createTypeScriptExpert(root: string): Promise<LanguageExpert> {
  const ts = (await import("ts6")).default as typeof TS;
  return new TypeScriptExpert(ts, root);
}

export const TS_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

class TypeScriptExpert implements LanguageExpert {
  readonly id = "typescript";
  readonly extensions = TS_EXTENSIONS;
  private readonly service: TS.LanguageService;
  private files: string[] = [];
  private readonly versions = new Map<string, string>();

  constructor(
    private readonly ts: typeof TS,
    private readonly root: string,
  ) {
    const options = compilerOptions(ts, root);
    const host: TS.LanguageServiceHost = {
      getScriptFileNames: () => this.files,
      getScriptVersion: (file) => this.versions.get(file) ?? "0",
      getScriptSnapshot: (file) => {
        try {
          return ts.ScriptSnapshot.fromString(readFileSync(file, "utf8"));
        } catch {
          return undefined;
        }
      },
      getCurrentDirectory: () => root,
      getCompilationSettings: () => options,
      getDefaultLibFileName: () => "lib.d.ts",
      fileExists: (file) => ts.sys.fileExists(file),
      readFile: (file) => ts.sys.readFile(file),
      readDirectory: (...args) => ts.sys.readDirectory(...args),
      directoryExists: (dir) => ts.sys.directoryExists(dir),
      getDirectories: (dir) => ts.sys.getDirectories(dir),
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  summarise(path: string, content: string): FileNode {
    const ts = this.ts;
    const sf = ts.createSourceFile(
      path,
      content,
      ts.ScriptTarget.Latest,
      false,
      scriptKind(ts, path),
    );
    const line = (node: TS.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const exports: ExportEntry[] = [];
    const isExported = (node: TS.Node) =>
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = (node: TS.Node) =>
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

    for (const statement of sf.statements) {
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const el of statement.exportClause.elements) {
          exports.push({ name: el.name.text, kind: "re-export", line: line(el) });
        }
        continue;
      }
      if (ts.isExportAssignment(statement)) {
        exports.push({ name: "default", kind: "default", line: line(statement) });
        continue;
      }
      if (!isExported(statement)) continue;
      const kind = declarationKind(ts, statement);
      if (ts.isVariableStatement(statement)) {
        for (const d of statement.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) exports.push({ name: d.name.text, kind, line: line(d) });
        }
      } else {
        const named = statement as TS.Node & { name?: TS.Identifier };
        const name = isDefault(statement) ? "default" : (named.name?.text ?? "default");
        exports.push({ name, kind, line: line(statement) });
      }
    }

    const imports = ts.preProcessFile(content, true, true).importedFiles.map((f) => f.fileName);
    return { path, exports, imports: [...new Set(imports)] };
  }

  findSymbols(files: readonly string[], query: string, exact: boolean, limit: number): SymbolHit[] {
    this.sync(files);
    const inScope = new Set(this.files);
    const items = this.service.getNavigateToItems(query, limit * 4, undefined, true);
    const hits: SymbolHit[] = [];
    for (const item of items) {
      if (!inScope.has(item.fileName)) continue;
      if (exact && item.name !== query) continue;
      const hit = this.hit(item);
      if (hit !== undefined) hits.push(hit);
      if (hits.length >= limit) break;
    }
    return hits.sort(
      (a, b) => Number(b.exported) - Number(a.exported) || a.path.localeCompare(b.path),
    );
  }

  findReferences(
    files: readonly string[],
    name: string,
    inFile: string | undefined,
    limit: number,
  ) {
    const candidates = this.findSymbols(files, name, true, 20).filter(
      (c) => inFile === undefined || c.path === inFile,
    );
    const definition = candidates[0];
    if (definition === undefined) return { definition, references: [], candidates };

    const file = this.abs(definition.path);
    const program = this.service.getProgram();
    const sf = program?.getSourceFile(file);
    if (sf === undefined) return { definition, references: [], candidates };
    // The position of the name inside the declaration line.
    const lineStart = sf.getPositionOfLineAndCharacter(definition.line - 1, 0);
    const at = sf.text.indexOf(name, lineStart);
    const groups = at < 0 ? undefined : this.service.findReferences(file, at);

    const references: ReferenceHit[] = [];
    for (const group of groups ?? []) {
      for (const ref of group.references) {
        const refFile = program?.getSourceFile(ref.fileName);
        if (refFile === undefined || !this.versions.has(ref.fileName)) continue;
        const pos = refFile.getLineAndCharacterOfPosition(ref.textSpan.start);
        const text = refFile.text.split("\n")[pos.line]?.trim() ?? "";
        references.push({
          path: this.rel(ref.fileName),
          line: pos.line + 1,
          text,
          isDefinition: ref.isDefinition === true,
        });
        if (references.length >= limit) break;
      }
    }
    references.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    return { definition, references, candidates };
  }

  /** Tell the language service which files exist and which changed (by modification time and size). */
  private sync(files: readonly string[]): void {
    this.files = files.map((f) => this.abs(f));
    const live = new Set(this.files);
    for (const file of this.versions.keys()) if (!live.has(file)) this.versions.delete(file);
    for (const file of this.files) {
      try {
        const info = statSync(file);
        this.versions.set(file, `${info.mtimeMs}:${info.size}`);
      } catch {
        this.versions.delete(file);
      }
    }
  }

  private hit(item: TS.NavigateToItem): SymbolHit | undefined {
    const sf = this.service.getProgram()?.getSourceFile(item.fileName);
    if (sf === undefined) return undefined;
    const line = sf.getLineAndCharacterOfPosition(item.textSpan.start).line + 1;
    return {
      name: item.name,
      kind: item.kind,
      path: this.rel(item.fileName),
      line,
      ...(item.containerName ? { container: item.containerName } : {}),
      exported: item.kindModifiers.split(",").includes("export"),
    };
  }

  private abs(path: string): string {
    return isAbsolute(path) ? path : join(this.root, path);
  }

  private rel(file: string): string {
    return relative(this.root, file).split(sep).join("/");
  }
}

function scriptKind(ts: typeof TS, path: string): TS.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function declarationKind(ts: typeof TS, node: TS.Node): string {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isVariableStatement(node)) return "const";
  return "other";
}

/**
 * Compiler options: the project's tsconfig.json when it has one (for paths and baseUrl),
 * then Garuda's needs on top: read JS too, emit nothing, and load no standard library
 * (the binary has no lib.d.ts files, and navigation does not need them).
 */
function compilerOptions(ts: typeof TS, root: string): TS.CompilerOptions {
  let base: TS.CompilerOptions = {};
  const configPath = ts.findConfigFile(root, (f) => ts.sys.fileExists(f));
  if (configPath !== undefined && dirname(configPath) === root) {
    const read = ts.readConfigFile(configPath, (f) => ts.sys.readFile(f));
    if (read.config !== undefined) {
      base = ts.parseJsonConfigFileContent(read.config, ts.sys, root).options;
    }
  }
  return {
    ...base,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: base.module ?? ts.ModuleKind.ESNext,
    moduleResolution: base.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
  };
}
