import { z } from "zod";
import type { ImpactResult, SymbolHit } from "../knowledge/index.js";
import { joinWithinLimit } from "./limits.js";
import type { Tool, ToolContext } from "./types.js";

/**
 * Semantic code intelligence tools: impact analysis and structural AST querying
 * across JS/TS, Python, and Java.
 */

function index(context: ToolContext) {
  if (context.knowledge === undefined)
    throw new Error("There is no code index in this session. Use grep.");
  return context.knowledge;
}

const where = (s: SymbolHit) =>
  `${s.path}:${s.line}  ${s.kind} ${s.container ? `${s.container}.` : ""}${s.name}${s.exported ? " (exported)" : ""}`;

const impactAnalysisInput = z.object({
  target: z
    .string()
    .min(1)
    .describe(
      "File path (e.g. 'src/tools/bash.ts' or 'service.py') or symbol name (e.g. 'runAgent') to analyze.",
    ),
});

export function impactAnalysisText(result: ImpactResult): string {
  const lines: string[] = [];
  const targetLabel = result.resolvedPath
    ? `${result.target} (${result.targetKind}: ${result.resolvedPath})`
    : `${result.target} (${result.targetKind})`;

  lines.push(`Impact Analysis for ${targetLabel}`);
  lines.push(`Risk Level: [${result.riskLevel.toUpperCase()}]`);
  lines.push("");

  if (result.definitions.length > 0) {
    lines.push(`Definitions (${result.definitions.length}):`);
    for (const d of result.definitions.slice(0, 10)) {
      lines.push(`  ${where(d)}`);
    }
    if (result.definitions.length > 10) {
      lines.push(`  … (${result.definitions.length - 10} more)`);
    }
    lines.push("");
  }

  lines.push(`Direct Dependents (${result.dependentFiles.length} file(s)):`);
  if (result.dependentFiles.length === 0) {
    lines.push("  None detected (leaf module or unreferenced symbol).");
  } else {
    for (const file of result.dependentFiles.slice(0, 20)) {
      lines.push(`  - ${file}`);
    }
    if (result.dependentFiles.length > 20) {
      lines.push(`  … (${result.dependentFiles.length - 20} more)`);
    }
  }
  lines.push("");

  lines.push(`Call Sites & Callers (${result.callers.length}):`);
  if (result.callers.length === 0) {
    lines.push("  No direct caller sites found in indexed code.");
  } else {
    for (const c of result.callers.slice(0, 15)) {
      lines.push(
        `  ${c.path}:${c.callLine}  ${c.callerName} (${c.callerKind})  →  ${c.callText.trim()}`,
      );
    }
    if (result.callers.length > 15) {
      lines.push(`  … (${result.callers.length - 15} more)`);
    }
  }
  lines.push("");

  lines.push(`Affected / Recommended Test Suites (${result.affectedTests.length}):`);
  if (result.affectedTests.length === 0) {
    lines.push("  No direct test files found. Suggest running existing caller tests.");
  } else {
    for (const testFile of result.affectedTests) {
      lines.push(`  ✓ ${testFile}`);
    }
  }
  lines.push("");
  lines.push(`Summary:\n${result.summary}`);

  return joinWithinLimit(lines).text;
}

export const impactAnalysisTool: Tool<z.infer<typeof impactAnalysisInput>, ImpactResult> = {
  name: "impact_analysis",
  description: [
    "Perform blast radius & dependency impact analysis for a file or symbol (JS/TS, Python, Java).",
    "Discovers direct dependents, caller hierarchies, risk assessment, and recommended test suites to run.",
  ].join("\n"),
  inputSchema: impactAnalysisInput,
  readOnly: true,
  async run({ target }, context) {
    return index(context).impactAnalysis(target);
  },
  toText: impactAnalysisText,
};

const astQueryInput = z.object({
  kind: z
    .string()
    .optional()
    .describe(
      "Filter by symbol kind: 'function', 'class', 'method', 'interface', 'record', 'variable', etc.",
    ),
  exported: z
    .boolean()
    .optional()
    .describe("Only match exported symbols (true) or non-exported symbols (false)."),
  container: z.string().optional().describe("Enclosing class, record, or module name."),
  namePattern: z
    .string()
    .optional()
    .describe("Symbol name pattern with optional wildcards (e.g. '*Handler' or 'get*')."),
  pathPrefix: z
    .string()
    .optional()
    .describe("Limit search to files starting with this path prefix."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum results to return (default: 50)."),
});

export function astQueryText(hits: SymbolHit[]): string {
  if (hits.length === 0) {
    return "No AST symbols matched the given structural query.";
  }
  const lines = hits.map(where);
  const head = `Found ${hits.length} matching symbol(s):`;
  return `${head}\n${joinWithinLimit(lines).text}`;
}

export const astQueryTool: Tool<z.infer<typeof astQueryInput>, SymbolHit[]> = {
  name: "ast_query",
  description: [
    "Perform structural AST queries across the codebase (JS/TS, Python, Java).",
    "Filter by symbol kind, exported visibility, enclosing class/container, and wildcard patterns.",
  ].join("\n"),
  inputSchema: astQueryInput,
  readOnly: true,
  async run(query, context) {
    return index(context).astQuery(query);
  },
  toText: astQueryText,
};
