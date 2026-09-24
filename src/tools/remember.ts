import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { MEMORY_FILE, MEMORY_MAX_CHARS } from "../context/instructions.js";
import { Redactor } from "../session/redact.js";
import type { Tool } from "./types.js";

const input = z.object({
  fact: z
    .string()
    .min(3)
    .max(300)
    .describe("One short fact about this project, for example: 'Tests run with: pnpm test'."),
});

const HEADER = [
  "# Garuda project memory",
  "",
  "Facts that Garuda learned about this project. They load into every new session.",
  "Edit or delete lines freely.",
  "",
  "",
].join("\n");

/**
 * remember: save a lasting fact about the project to .garuda/memory.md.
 * The next session loads the file into its system prompt, so the agent does not find
 * the same facts again. The current session keeps its system prompt unchanged (N2).
 */
export const rememberTool: Tool<z.infer<typeof input>> = {
  name: "remember",
  description: [
    "Save one lasting fact about this project to the project memory (.garuda/memory.md).",
    "Save only facts that stay true for the whole project and save work in later tasks:",
    "how to build and test, where things are, conventions. Example: 'Tests run with: node --test'.",
    "Never save what you found, fixed or changed in this task: that belongs in your answer, not in memory.",
    "Do not save guesses or secrets. The fact loads in the next session, not in this one.",
    "The user approves each fact.",
  ].join("\n"),
  inputSchema: input,
  readOnly: false,

  async describe({ fact }) {
    return { target: { kind: "path", path: MEMORY_FILE }, preview: `+ - ${clean(fact)}` };
  },

  async run({ fact }, { root }) {
    const path = join(root, MEMORY_FILE);
    const current = await readFile(path, "utf8").catch(() => "");
    const line = `- ${clean(fact)}`;
    const known = current.split("\n").map((l) => l.trim().toLowerCase());
    if (known.includes(line.toLowerCase())) return "The project memory already has this fact.";

    const next = `${current === "" ? HEADER : current.endsWith("\n") ? current : `${current}\n`}${line}\n`;
    if (next.length > MEMORY_MAX_CHARS) {
      throw new Error(
        `The project memory is full (${MEMORY_MAX_CHARS} characters). Ask the user to clean up ${MEMORY_FILE}.`,
      );
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, next);
    return `Saved to ${MEMORY_FILE}. It loads in the next session.`;
  },
};

/** One line, no secrets. */
function clean(fact: string): string {
  return new Redactor().text(fact.replace(/\s+/g, " ").trim());
}
