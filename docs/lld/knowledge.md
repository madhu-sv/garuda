# Code index and dynamic language plugins (`src/knowledge/`)

## Purpose

Answer "where is X defined", "who uses X", "who calls X", "what is the blast radius and affected tests of changing X", and "what does each file export and import" on this machine, with no model call. Each language has its own expert.

Version 0.16 introduces a **dynamic language plugin architecture** with:
- Built-in reference plugins: TypeScript/JavaScript, Python, Java, Go, and Rust.
- User plugins in `~/.garuda/languages/`.
- Project plugins in `<root>/.garuda/languages/`: not loaded (merge gate; see below).
- Zero native C++ compilation dependencies, preserving instant sub-1s startup and single-binary packaging.

## Interfaces (`types.ts`)

```ts
interface LanguageExpert {
  readonly id: string;
  readonly extensions: readonly string[];
  summarise(path, content): FileNode;                         // exports + imports, cheap, cached
  findSymbols(files, query, exact, limit): SymbolHit[];
  findReferences(files, name, inFile, limit):
    { definition?: SymbolHit; references: ReferenceHit[]; candidates: SymbolHit[] };
}

interface LanguagePlugin {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly source: "built-in" | "user" | "project";
  readonly path?: string;
  readonly factory: ExpertFactory;
}

interface LanguageStatus {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly source: "built-in" | "user" | "project";
  readonly indexedFiles: number;
  readonly active: boolean;
}

interface SymbolHit { name; kind; path; line; container?; exported }
interface ReferenceHit { path; line; text; isDefinition }
interface CallerHit { callerName; callerKind; path; line; callLine; callText }
interface CallerResult { definition?; callers: CallerHit[]; candidates: SymbolHit[] }
interface ImpactResult {
  target: string;
  targetKind: "file" | "symbol";
  resolvedPath?: string;
  definitions: SymbolHit[];
  dependentFiles: string[];
  callers: CallerHit[];
  affectedTests: string[];
  riskLevel: "low" | "medium" | "high" | "unknown";
  summary: string;
}
interface AstQueryOptions { kind?; exported?; container?; namePattern?; pathPrefix?; limit? }
interface FileNode { path; exports: ExportEntry[]; imports: string[] }
```

## KnowledgeIndex (`index.ts`)

- Lists files with the same rules as `glob` (`.gitignore`), skips sensitive files, files over 1 MB, and
  stops at 5 000 files. Groups files by the expert that owns their extension.
- `languageStatuses()`: reports all registered language plugins, their source, active/standby state, and file count.
- `findSymbols(query, exact, limit = 50)`: asks every expert and merges.
- `findReferences(name, inFile?, limit = 200)`: the first expert that finds the definition answers.
- `findCallers(name, inFile?, limit = 50)`: the call sites and the definition that holds each one
  (`scope.ts`, 0.14): by indentation in Python, and only inside a body (brace depth > 0) in the C-like
  languages; top-level code is `<module>`.
- `impactAnalysis(target)`: direct dependents (a file whose import names the target: relative imports
  resolved, module names matched on the end of the path, Go packages by folder; `importNames`), caller
  sites, a risk (low/medium/high, or `unknown` when the target is neither a file nor a symbol), and the
  affected tests (`*.test.ts`, `test_*.py`, `*Test.java`, `*_test.go`, `*_test.rs`).
- `astQuery(options)`: filters every symbol by kind, visibility, container and wildcard pattern, then
  applies the limit.
- `repoMap` skips a file that vanished since the listing and writes its cache on a best-effort basis.
  The experts load once, also for parallel calls. A user plugin's factory runs once, with the root.
- Parser fixes (0.14): TS references find the name as a whole word on its line; Python multi-line
  strings that open mid-line (`X = """`); Go `var (`/`const (`/`type (` groups and generics; Java type
  declarations anchored at the line start, and `else`/`return`/`yield` lines are not methods.
- `repoMap(dir)`: file nodes; unchanged files (same content hash) come from the cache in
  `.garuda/index/code-graph.json` (versioned). The cache is rewritten after each map.
- Experts load lazily on first use, so the index costs nothing at startup.

## Built-in Language Plugins

### TypeScript / JavaScript (`typescript.ts`)
- Uses the TypeScript 6 language service (`ts6` package alias).
- Extensions: `.ts .tsx .mts .cts .js .jsx .mjs .cjs`.
- Follows imports, re-exports, and renames across files.

### Python (`python.ts`)
- Pure AST parser for Python source code.
- Extensions: `.py`.
- Extracts imports, functions, async functions, classes, methods, constructors, variables, and constants.
- Respects `__all__` export manifests and private naming conventions (`_foo`).

### Java (`java.ts`)
- Pure AST parser for Java source code.
- Extensions: `.java`.
- Extracts packages, imports, classes, interfaces, records, enums, methods, constructors, and fields.
- Tracks brace nesting depth for container resolution.

### Go (`plugins/go.ts` — 0.16)
- Pure AST parser for Go source code.
- Extensions: `.go`.
- Extracts packages, imports (single and block `import ( ... )`), structs, interfaces, type aliases.
- Extracts functions and receiver methods (`func (r *Receiver) Method(...)`), setting receiver type as container.
- Determines export status by capitalized identifier convention (`[A-Z]`).

### Rust (`plugins/rust.ts` — 0.16)
- Pure AST parser for Rust source code.
- Extensions: `.rs`.
- Extracts modules (`mod`), imports (`use`), structs, enums, traits, type aliases, free functions, and macros (`macro_rules!`).
- Tracks `impl [Trait for] Type { ... }` blocks with brace depth stack to associate methods with their container type.
- Identifies `pub` visibility for export status.

## Plugin Discovery & Security (`plugins.ts`)

- **Built-in plugins**: always available without file reads.
- **User plugins**: loaded from `~/.garuda/languages/<name>.js` (or `.mjs`, `.ts`). They run in Garuda's own
  process under the user's trust. `discoverPlugins` needs an explicit `home`. A `KnowledgeIndex` with no
  `home` uses the built-in experts only. The runtime gives it a home only when `RuntimeOptions.languages`
  is set (the CLI sets it; tests and evals do not), so a test never runs code from the real home folder.
- **Project plugins** (`<root>/.garuda/languages/<name>.js`): not loaded (merge gate). A plugin runs in
  Garuda's own process with no sandbox, no consent flow writes the pin yet, and the SHA-256 pin in
  `~/.garuda/trust.json` covers only the entry file, not the files it imports (G09). Discovery adds a
  warning that names the skipped files; `/languages` shows it. The pinned path stays behind
  `discoverPlugins({ projectPlugins: true })` for tests and for a future consent flow.

## Use

| Mode (`codeIndex` in settings) | Model tools | User commands |
| --- | --- | --- |
| `off` (default) | none | `/where`, `/defs`, `/refs`, `/callers`, `/impact`, `/map`, `/languages` |
| `lookup` | `find_symbol`, `find_references`, `find_callers`, `impact_analysis`, `ast_query` | same |
| `all` | also `repo_map` | same |

## Tests

`test/knowledge.plugins.test.ts`, `test/knowledge.experts.test.ts`, `test/codeIndex.test.ts`, `test/tools.test.ts`.
