import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { readFileTool } from "./readFile.js";
import type { AnyTool } from "./types.js";

/** The tools that Garuda 0.1 ships. M3 adds write_file, edit_file and bash. */
export function defaultTools(): AnyTool[] {
  return [readFileTool, globTool, grepTool];
}
