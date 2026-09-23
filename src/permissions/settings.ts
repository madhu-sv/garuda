import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { EXECUTOR_NAMES } from "../sandbox/index.js";
import { parseRule, type Rule } from "./rules.js";

/**
 * Project settings: `.garuda/settings.json` in the working root (F19).
 *
 * {
 *   "executor": "host",
 *   "permissions": {
 *     "allow": ["bash(pnpm test*)", "edit_file(src/**)"],
 *     "deny":  ["bash(rm -rf*)", "bash(git push*)"]
 *   },
 *   "env": { "allow": ["NODE_ENV"] }
 * }
 */

export const SETTINGS_FILE = join(".garuda", "settings.json");

const schema = z.strictObject({
  executor: z.enum(EXECUTOR_NAMES).optional(),
  permissions: z
    .strictObject({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  env: z.strictObject({ allow: z.array(z.string()).optional() }).optional(),
});

export interface Settings {
  executor: (typeof EXECUTOR_NAMES)[number];
  allow: Rule[];
  deny: Rule[];
  /** Extra environment variables that commands may see. */
  envAllow: string[];
}

export const DEFAULT_SETTINGS: Settings = { executor: "host", allow: [], deny: [], envAllow: [] };

export function parseSettings(json: unknown, source = SETTINGS_FILE): Settings {
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${source}: ${z.prettifyError(parsed.error)}`);
  const { executor = "host", permissions = {}, env = {} } = parsed.data;
  const rules = (list: string[] = []) =>
    list.map((text) => {
      try {
        return parseRule(text);
      } catch (error) {
        throw new Error(`${source}: ${(error as Error).message}`);
      }
    });
  return {
    executor,
    allow: rules(permissions.allow),
    deny: rules(permissions.deny),
    envAllow: env.allow ?? [],
  };
}

/** Read the settings file. A missing file gives the defaults. A broken file is an error. */
export async function loadSettings(root: string): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(join(root, SETTINGS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SETTINGS;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${SETTINGS_FILE}: invalid JSON: ${(error as Error).message}`);
  }
  return parseSettings(json);
}
