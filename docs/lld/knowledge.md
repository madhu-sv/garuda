# Code index (`src/knowledge/`)

## Purpose

Answer "where is X defined", "who uses X" and "what does each file export and import" on this machine,
with no model call. Each language has its own expert. 0.2 ships the TypeScript/JavaScript expert.

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
interface FileNode { path; exports: ExportEntry[]; imports: string[] }
```

## KnowledgeIndex (`index.ts`)

- Lists files with the same rules as `glob` (`.gitignore`), skips sensitive files, files over 1 MB, and
  stops at 5 000 files. Groups files by the expert that owns their extension.
- `findSymbols(query, exact, limit = 50)`: asks every expert and merges.
- `findReferences(name, inFile?, limit = 200)`: the first expert that finds the definition answers.
- `repoMap(dir)`: file nodes; unchanged files (same content hash) come from the cache in
  `.garuda/index/code-graph.json` (versioned). The cache is rewritten after each map.
- Experts load on first use (`DEFAULT_EXPERTS` are factories), so the index costs nothing at startup.

## TypeScript expert (`typescript.ts`)

- Uses the TypeScript 6 language service. TypeScript 6 is the last compiler written in JavaScript, so it
  fits in the single binary; TypeScript 7 is a native binary. The package alias is `ts6`, loaded with
  `import()` (N3).
- Extensions: `.ts .tsx .mts .cts .js .jsx .mjs .cjs`.
- Compiler options: the project's `tsconfig.json` when it exists (for `paths` and `baseUrl`), then `allowJs`,
  no emit and no default library (the binary has no `lib.d.ts`; navigation does not need it).
- `findReferences` follows imports, re-exports and renames, which grep cannot.

## Use

| Mode (`codeIndex` in settings) | Model tools | User commands |
| --- | --- | --- |
| `off` (default) | none | `/where`, `/refs`, `/map` |
| `lookup` | `find_symbol`, `find_references` | same |
| `all` | also `repo_map` | same |

The default is `off` because an A/B test on the hard eval suite (claude-sonnet-5, 3 runs per task) showed
no gain: off 50.0 steps / $0.194; lookup 53.2 / $0.242; all 51.2 / $0.232.

## Adding a language

Write a `LanguageExpert` for the language (a real parser or language service, not a generic one), add
its factory to `DEFAULT_EXPERTS`, and add tests like `test/knowledge.test.ts`.

## Tests

`test/knowledge.test.ts`, `test/codeIndex.test.ts`.
