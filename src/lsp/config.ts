import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * The user's LSP file, ~/.garuda/lsp.json (0.4). It is only in the home folder: a project must not
 * be able to make Garuda download programs.
 *
 *   { "autoInstall": true }   ask to install a missing server when an edit needs it
 *
 * Default: no question; Garuda uses the managed install or PATH, and says how to install.
 */
export const LSP_CONFIG_FILE = join(".garuda", "lsp.json");

const schema = z.strictObject({ autoInstall: z.boolean().optional() });

export interface LspConfig {
  autoInstall: boolean;
}

export async function loadLspConfig(home: string = homedir()): Promise<LspConfig> {
  const file = join(home, LSP_CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { autoInstall: false };
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return { autoInstall: parsed.data.autoInstall === true };
}
