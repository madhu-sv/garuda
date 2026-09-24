import { type CodeIndexMode, DEFAULT_CODE_INDEX_MODE } from "../knowledge/mode.js";
import { bashTool } from "./bash.js";
import { findReferencesTool, findSymbolTool, repoMapTool } from "./codeTools.js";
import { editFileTool } from "./editFile.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { readFileTool } from "./readFile.js";
import { rememberTool } from "./remember.js";
import type { AnyTool } from "./types.js";
import { createWebFetchTool, type WebFetchOptions } from "./webFetch.js";
import { writeFileTool } from "./writeFile.js";

/**
 * The tools that Garuda ships. `codeIndex` picks which code index tools the model gets.
 * `web` adds web_fetch (the Runtime passes it unless settings turn it off).
 */
export function defaultTools({
  codeIndex = DEFAULT_CODE_INDEX_MODE,
  web,
}: {
  codeIndex?: CodeIndexMode;
  web?: WebFetchOptions;
} = {}): AnyTool[] {
  return [
    readFileTool,
    globTool,
    grepTool,
    ...(codeIndex === "off" ? [] : [findSymbolTool, findReferencesTool]),
    ...(codeIndex === "all" ? [repoMapTool] : []),
    writeFileTool,
    editFileTool,
    bashTool,
    rememberTool,
    ...(web === undefined ? [] : [createWebFetchTool(web)]),
  ];
}
