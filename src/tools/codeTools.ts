import { z } from "zod";
import { referenceWarning } from "../knowledge/accuracy.js";
import type { CallerResult, FileNode, ReferenceHit, SymbolHit } from "../knowledge/index.js";
import { joinWithinLimit } from "./limits.js";
import type { Tool, ToolContext } from "./types.js";

/**
 * Code tools backed by the local code index (JS/TS, Python, Java). They run on this machine,
 * need no approval. Reference accuracy depends on the language expert.
 */

function index(context: ToolContext) {
  if (context.knowledge === undefined)
    throw new Error("There is no code index in this session. Use grep.");
  return context.knowledge;
}

const where = (s: SymbolHit) =>
  `${s.path}:${s.line}  ${s.kind} ${s.container ? `${s.container}.` : ""}${s.name}${s.exported ? " (exported)" : ""}`;

const findSymbolInput = z.object({
  name: z.string().min(1).describe("The symbol name, for example formatPrice or OrderService."),
  exact: z
    .boolean()
    .optional()
    .describe("Only this exact name. Default: false (prefix and fuzzy matches too)."),
});

export function findSymbolText(hits: SymbolHit[]): string {
  if (hits.length === 0) {
    return "No definition found. The index covers JS/TS, Python and Java files; try grep for other files.";
  }
  return joinWithinLimit(hits.map(where)).text;
}

export const findSymbolTool: Tool<z.infer<typeof findSymbolInput>, SymbolHit[]> = {
  name: "find_symbol",
  description: [
    "Find where a function, class, method, variable or type is defined (JS/TS, Python, Java).",
    "Returns path:line, kind and whether it is exported. Java/Python declarations are extracted with heuristics.",
  ].join("\n"),
  inputSchema: findSymbolInput,
  readOnly: true,
  async run({ name, exact = false }, context) {
    return index(context).findSymbols(name, exact, 50);
  },
  toText: findSymbolText,
};

const findReferencesInput = z.object({
  name: z.string().min(1).describe("The symbol name, for example formatPrice."),
  path: z
    .string()
    .optional()
    .describe("The file that defines the symbol, when several files define the same name."),
});

type ReferencesOutput = Awaited<
  ReturnType<NonNullable<ToolContext["knowledge"]>["findReferences"]>
>;

export function referencesText(result: ReferencesOutput): string {
  const { definition, references, candidates } = result;
  const warning = referenceWarning(result);
  if (definition === undefined)
    return `${warning}No definition with this name. Check the name with find_symbol.`;
  const files = new Set(references.map((r) => r.path));
  const lines = references.map(
    (r: ReferenceHit) => `${r.path}:${r.line}  ${r.text}${r.isDefinition ? "  [definition]" : ""}`,
  );
  const head = `${definition.name} is defined at ${definition.path}:${definition.line} (${definition.kind}). ${references.length} reference(s) in ${files.size} file(s):`;
  const others =
    candidates.length > 1
      ? `\n[${candidates.length} definitions have this name; this is the first. Pass path to choose: ${candidates
          .slice(1, 6)
          .map((c) => `${c.path}:${c.line}`)
          .join(", ")}]`
      : "";
  return `${warning}${head}\n${joinWithinLimit(lines).text}${others}`;
}

export const findReferencesTool: Tool<z.infer<typeof findReferencesInput>, ReferencesOutput> = {
  name: "find_references",
  description: [
    "Find indexed references to a symbol (JS/TS, Python, Java).",
    "JS/TS uses language-service bindings. Java/Python identifier matching is approximate: it can include unrelated names and miss aliases or dynamic uses.",
    "Use it to see who calls a function, to plan a rename, or to find unused code.",
  ].join("\n"),
  inputSchema: findReferencesInput,
  readOnly: true,
  async run({ name, path }, context) {
    return index(context).findReferences(name, path?.replace(/^\.\//, ""), 200);
  },
  toText: referencesText,
};

const findCallersInput = z.object({
  name: z
    .string()
    .min(1)
    .describe("The function, method, or class name to find callers of, for example runAgent."),
  path: z
    .string()
    .optional()
    .describe(
      "The file path where the symbol is defined, when multiple files declare the same symbol name.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of callers to return (default: 50)."),
});

export function callersText(result: CallerResult): string {
  const { definition, callers, candidates } = result;
  const warning = referenceWarning(result);
  if (definition === undefined) {
    return `${warning}No definition with this name. Check the name with find_symbol.`;
  }
  if (callers.length === 0) {
    return `${warning}${definition.name} (${definition.path}:${definition.line}) has no callers found in indexed code.`;
  }
  const lines = callers.map(
    (c) =>
      `${c.path}:${c.callLine}  ${c.callerName} (${c.callerKind}) calls ${definition.name}  →  ${c.callText.trim()}`,
  );
  const head = `${definition.name} is defined at ${definition.path}:${definition.line} (${definition.kind}). ${callers.length} caller site(s):`;
  const others =
    candidates.length > 1
      ? `\n[${candidates.length} definitions have this name; this is the first. Pass path to choose: ${candidates
          .slice(1, 6)
          .map((c) => `${c.path}:${c.line}`)
          .join(", ")}]`
      : "";
  return `${warning}${head}\n${joinWithinLimit(lines).text}${others}`;
}

export const findCallersTool: Tool<z.infer<typeof findCallersInput>, CallerResult> = {
  name: "find_callers",
  description: [
    "Find indexed caller candidates and their enclosing scopes (JS/TS, Python, Java).",
    "Java/Python results are approximate identifier matches, including matches that may not be calls. Validate before planning changes.",
  ].join("\n"),
  inputSchema: findCallersInput,
  readOnly: true,
  async run({ name, path, limit = 50 }, context) {
    return index(context).findCallers(name, path?.replace(/^\.\//, ""), limit);
  },
  toText: callersText,
};

const repoMapInput = z.object({
  path: z
    .string()
    .optional()
    .describe("A folder, relative to the working root. Default: the whole project."),
});

/** Above this many files, repo_map shows one line per folder, not one per file. */
export const REPO_MAP_FILE_LIMIT = 30;

/**
 * The repo map as text. A small scope shows each file with its exports and imports.
 * A large scope shows one line per folder (file count and exported names), because every
 * later step sends this output to the model again: a full map of 100 files costs more
 * tokens than it saves. The model can then call repo_map again for one folder.
 */
export function repoMapText(nodes: FileNode[]): string {
  if (nodes.length === 0) return "No indexed code files here.";
  if (nodes.length > REPO_MAP_FILE_LIMIT) return folderSummary(nodes);
  const lines = nodes.map((n) => {
    const exports = n.exports.map((e) => `${e.name} (${e.kind})`).join(", ") || "-";
    const imports = n.imports.length === 0 ? "" : `  ← ${n.imports.join(", ")}`;
    return `${n.path}: ${exports}${imports}`;
  });
  return joinWithinLimit(lines).text;
}

function folderSummary(nodes: FileNode[]): string {
  const folders = new Map<string, FileNode[]>();
  for (const node of nodes) {
    const dir = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : ".";
    folders.set(dir, [...(folders.get(dir) ?? []), node]);
  }
  const lines = [...folders.entries()].map(([dir, files]) => {
    const names = files.flatMap((f) => f.exports.map((e) => e.name));
    const shown = names.slice(0, 8).join(", ");
    const more = names.length > 8 ? `, … (${names.length - 8} more)` : "";
    return `${dir}/ (${files.length} files): ${shown || "-"}${more}`;
  });
  const head = `${nodes.length} files in ${folders.size} folders. Call repo_map with a folder in path for each file's exports and imports.`;
  return `${head}\n${joinWithinLimit(lines).text}`;
}

export const repoMapTool: Tool<z.infer<typeof repoMapInput>, FileNode[]> = {
  name: "repo_map",
  description: [
    "Show the structure of the code. For a folder of up to 30 code files: each file with its exports and imports (JS/TS, Python, Java).",
    "For a larger scope: one line per folder with its exported names. Then call it again for one folder.",
    "Use it in an unknown project to see where things are without reading every file.",
  ].join("\n"),
  inputSchema: repoMapInput,
  readOnly: true,
  async run({ path }, context) {
    return index(context).repoMap(path ?? "");
  },
  toText: repoMapText,
};
