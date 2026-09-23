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
