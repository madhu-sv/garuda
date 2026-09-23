import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const INSTRUCTIONS_FILE = "GARUDA.md";
/** Longer files are cut, so one file cannot fill the context. */
export const INSTRUCTIONS_MAX_CHARS = 40_000;

/** Read GARUDA.md from the working root (F21). Undefined when there is no file. */
export async function loadInstructions(root: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(root, INSTRUCTIONS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  text = text.trim();
  if (text === "") return undefined;
  if (text.length <= INSTRUCTIONS_MAX_CHARS) return text;
  return `${text.slice(0, INSTRUCTIONS_MAX_CHARS)}\n… [${INSTRUCTIONS_FILE} cut at ${INSTRUCTIONS_MAX_CHARS} characters]`;
}

/**
 * The system prompt. Garuda builds it once per process and sends the same bytes
 * on every request, so the prompt cache stays valid (N2). It holds no time or counters.
 */
export function buildSystemPrompt(root: string, instructions: string | undefined): string {
  const base = [
    "You are Garuda, a coding agent in a terminal.",
    `You work inside one project folder, the working root: ${root}`,
    "Use the tools to look at the code before you answer. Do not guess file contents.",
    "To look at files, use glob (find files by name), grep (search contents) and read_file (read a file).",
    "These three tools run at once, with no approval. Do not use bash for ls, cat, head, tail, find or grep.",
    "Use edit_file to change a file and write_file to create one. Read the file with read_file first:",
    "edit_file refuses a file that read_file did not read in this session.",
    "Use bash only to run programs, for example tests and builds. The user approves each command and each file change.",
    "Each bash call starts in the working root. Do not cd to it, and do not use absolute paths.",
    "Do not pipe a command into tail or head: the pipe hides the exit code, and Garuda already cuts long output.",
    "If the user denies a call, do not retry it. Ask what to do instead.",
    "Paths are relative to the working root.",
    "Be brief. Cite file paths and line numbers when you point to code.",
  ].join("\n");
  if (instructions === undefined) return base;
  return [
    base,
    "",
    `# Project instructions (${INSTRUCTIONS_FILE})`,
    "The project owner wrote these instructions. Follow them unless they conflict with the user's request.",
    "",
    instructions,
  ].join("\n");
}
