import { bashTool } from "./bash.js";
import { findReferencesTool, findSymbolTool, repoMapTool } from "./codeTools.js";
import { editFileTool } from "./editFile.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { readFileTool } from "./readFile.js";
import { rememberTool } from "./remember.js";
import type { AnyTool } from "./types.js";
import { writeFileTool } from "./writeFile.js";

/**
 * The tools that Garuda ships. `codeIndex: false` leaves out the code index tools
 * (find_symbol, find_references, repo_map), for A/B evals and for users who do not want them.
 */
export function defaultTools({ codeIndex = true }: { codeIndex?: boolean } = {}): AnyTool[] {
  return [
    readFileTool,
    globTool,
    grepTool,
    ...(codeIndex ? [findSymbolTool, findReferencesTool, repoMapTool] : []),
    writeFileTool,
    editFileTool,
    bashTool,
    rememberTool,
  ];
}
