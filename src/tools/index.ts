import { bashTool } from "./bash.js";
import { editFileTool } from "./editFile.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { readFileTool } from "./readFile.js";
import { rememberTool } from "./remember.js";
import type { AnyTool } from "./types.js";
import { writeFileTool } from "./writeFile.js";

/** The tools that Garuda 0.1 ships. */
export function defaultTools(): AnyTool[] {
  return [readFileTool, globTool, grepTool, writeFileTool, editFileTool, bashTool, rememberTool];
}
