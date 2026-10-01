# Code index (`src/knowledge/`)

## Purpose

Answer "where is X defined", "who uses X", "who calls X", "what is the blast radius and affected tests of changing X", and "what does each file export and import" on this machine, with no model call. Each language has its own expert. 0.15 ships the TypeScript/JavaScript, Python, and Java experts with zero native C++ compilation dependencies.

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
  riskLevel: "low" | "medium" | "high";
  summary: string;
}
interface AstQueryOptions { kind?; exported?; container?; namePattern?; pathPrefix?; limit? }
interface FileNode { path; exports: ExportEntry[]; imports: string[] }
```

## KnowledgeIndex (`index.ts`)

- Lists files with the same rules as `glob` (`.gitignore`), skips sensitive files, files over 1 MB, and
  stops at 5 000 files. Groups files by the expert that owns their extension.
- `findSymbols(query, exact, limit = 50)`: asks every expert and merges.
- `findReferences(name, inFile?, limit = 200)`: the first expert that finds the definition answers.
- `findCallers(name, inFile?, limit = 50)`: traces invocation sites and resolves enclosing caller scope (class, method, function).
- `impactAnalysis(target)`: computes blast radius, direct dependents, caller sites, risk classification (low/medium/high), and automatically discovers affected test suites (`*.test.ts`, `test_*.py`, `*Test.java`).
- `astQuery(options)`: structural query across indexed ASTs filtering by symbol kind, visibility, container, and wildcard patterns.
- `repoMap(dir)`: file nodes; unchanged files (same content hash) come from the cache in
  `.garuda/index/code-graph.json` (versioned). The cache is rewritten after each map.
- Experts load on first use (`DEFAULT_EXPERTS` are factories), so the index costs nothing at startup.

## Language Experts

### TypeScript / JavaScript expert (`typescript.ts`)

- Uses the TypeScript 6 language service. TypeScript 6 is the last compiler written in JavaScript, so it
  fits in the single binary; TypeScript 7 is a native binary. The package alias is `ts6`, loaded with
  `import()` (N3).
- Extensions: `.ts .tsx .mts .cts .js .jsx .mjs .cjs`.
- Compiler options: the project's `tsconfig.json` when it exists (for `paths` and `baseUrl`), then `allowJs`,
  no emit and no default library (the binary has no `lib.d.ts`; navigation does not need it).
- `findReferences` follows imports, re-exports and renames, which grep cannot.

### Python expert (`python.ts` — 0.15)

- Pure TypeScript/JavaScript AST parser for Python source code.
- Extensions: `.py`.
- Extracts `import`, `from ... import`, functions, async functions, classes, methods, constructors, variables, and constants.
- Respects `__all__` export manifests and Python private naming conventions (`_single_underscore`).
- Tracks class nesting and container scopes.

### Java expert (`java.ts` — 0.15)

- Pure TypeScript/JavaScript AST parser for Java source code.
- Extensions: `.java`.
- Extracts packages, imports (including static imports), classes, interfaces, records, enums, methods, constructors, and fields.
- Tracks brace nesting depth to accurately associate member methods and fields with their enclosing class/record container.

## Use

| Mode (`codeIndex` in settings) | Model tools | User commands |
| --- | --- | --- |
| `off` (default) | none | `/where`, `/defs`, `/refs`, `/callers`, `/impact`, `/map` |
| `lookup` | `find_symbol`, `find_references`, `find_callers`, `impact_analysis`, `ast_query` | same |
| `all` | also `repo_map` | same |

## Tests

`test/knowledge.experts.test.ts`, `test/codeIndex.test.ts`, `test/tools.test.ts`.
