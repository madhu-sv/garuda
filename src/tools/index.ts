import { type CodeIndexMode, DEFAULT_CODE_INDEX_MODE } from "../knowledge/mode.js";
import { createBashTool } from "./bash.js";
import { findCallersTool, findReferencesTool, findSymbolTool, repoMapTool } from "./codeTools.js";
import { editFileTool } from "./editFile.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { astQueryTool, impactAnalysisTool } from "./impactAnalysis.js";
import { processManagerTool } from "./processManager.js";
import { readFileTool } from "./readFile.js";
import { rememberTool } from "./remember.js";
import { todoWriteTool } from "./todo.js";
import type { AnyTool } from "./types.js";
import { createWebFetchTool, type WebFetchOptions } from "./webFetch.js";
import { writeFileTool } from "./writeFile.js";

export { astQueryTool, findCallersTool, impactAnalysisTool, processManagerTool };

/** The read-only tools for a subagent: file search and reads, and the code index when it is on. */
export function readOnlyTools(codeIndex: CodeIndexMode = DEFAULT_CODE_INDEX_MODE): AnyTool[] {
  return [
    readFileTool,
    globTool,
    grepTool,
    ...(codeIndex === "off"
      ? []
      : [findSymbolTool, findReferencesTool, findCallersTool, impactAnalysisTool, astQueryTool]),
    ...(codeIndex === "all" ? [repoMapTool] : []),
  ];
}

/**
 * The tools that Garuda ships. `codeIndex` picks which code index tools the model gets.
 * `web` adds web_fetch (the Runtime passes it unless settings turn it off).
 */
export function defaultTools({
  codeIndex = DEFAULT_CODE_INDEX_MODE,
  web,
  todo = false,
  daemons = false,
  strict = false,
}: {
  codeIndex?: CodeIndexMode;
  web?: WebFetchOptions;
  /** todo_write (0.4). Off by default until an A/B eval decides. */
  todo?: boolean;
  /** bash is_daemon and process_manager (0.14). Off by default (merge gate). */
  daemons?: boolean;
  /** The strict profile (0.17): bash without outside_sandbox. */
  strict?: boolean;
} = {}): AnyTool[] {
  return [
    readFileTool,
    globTool,
    grepTool,
    ...(codeIndex === "off"
      ? []
      : [findSymbolTool, findReferencesTool, findCallersTool, impactAnalysisTool, astQueryTool]),
    ...(codeIndex === "all" ? [repoMapTool] : []),
    writeFileTool,
    editFileTool,
    createBashTool({ daemons, strict }),
    ...(daemons ? [processManagerTool] : []),
    rememberTool,
    ...(web === undefined ? [] : [createWebFetchTool(web)]),
    ...(todo ? [todoWriteTool] : []),
  ];
}
