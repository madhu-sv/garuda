/**
 * Local code knowledge. Garuda answers "where is X defined" and "who uses X" from an index
 * on this machine, with no model call. Each language has its own expert: a module that
 * understands that language well. 0.1 ships the TypeScript/JavaScript expert.
 */

export interface SymbolHit {
  name: string;
  /** function, class, method, variable, interface, type, … */
  kind: string;
  /** Relative to the root, forward slashes. */
  path: string;
  line: number;
  /** The class or module that holds the symbol, if any. */
  container?: string;
  exported: boolean;
}

export interface ReferenceHit {
  path: string;
  line: number;
  /** The source line, trimmed. */
  text: string;
  isDefinition: boolean;
}

export interface CallerHit {
  callerName: string;
  callerKind: string;
  path: string;
  line: number;
  callLine: number;
  callText: string;
}

export interface CallerResult {
  definition?: SymbolHit | undefined;
  callers: CallerHit[];
  candidates: SymbolHit[];
}

export interface ImpactResult {
  target: string;
  targetKind: "file" | "symbol";
  resolvedPath?: string | undefined;
  definitions: SymbolHit[];
  dependentFiles: string[];
  callers: CallerHit[];
  affectedTests: string[];
  riskLevel: "low" | "medium" | "high";
  summary: string;
}

export interface AstQueryOptions {
  /** Filter by symbol kind, e.g. "function", "class", "method", "interface", "record", "variable" */
  kind?: string | undefined;
  /** Only exported symbols (true) or non-exported (false) */
  exported?: boolean | undefined;
  /** Enclosing class/interface/container name */
  container?: string | undefined;
  /** Substring or glob pattern (with * wildcards) for the symbol name */
  namePattern?: string | undefined;
  /** Limit search to a specific directory or file path prefix */
  pathPrefix?: string | undefined;
  /** Max results (default: 50) */
  limit?: number | undefined;
}

export interface ExportEntry {
  name: string;
  kind: string;
  line: number;
}

/** One node of the code graph: a file, what it exports, and which files it imports. */
export interface FileNode {
  path: string;
  exports: ExportEntry[];
  /** Import specifiers as written, for example "../core/money.js". */
  imports: string[];
}

/** A language expert. The index sends it only files with its extensions. */
export interface LanguageExpert {
  readonly id: string;
  readonly extensions: readonly string[];
  /** Parse one file: exports and imports. Cheap; the index caches it by content hash. */
  summarise(path: string, content: string): FileNode;
  /** Definitions whose name matches `query`. */
  findSymbols(files: readonly string[], query: string, exact: boolean, limit: number): SymbolHit[];
  /** References to the symbol `name` (defined in `inFile`, if given). */
  findReferences(
    files: readonly string[],
    name: string,
    inFile: string | undefined,
    limit: number,
  ): {
    definition: SymbolHit | undefined;
    references: ReferenceHit[];
    candidates: SymbolHit[];
  };
}

export type ExpertFactory = (root: string) => Promise<LanguageExpert> | LanguageExpert;

export interface LanguagePlugin {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly source: "built-in" | "user" | "project";
  readonly path?: string | undefined;
  readonly factory: ExpertFactory;
}

export interface LanguageStatus {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly source: "built-in" | "user" | "project";
  readonly indexedFiles: number;
  readonly active: boolean;
}
