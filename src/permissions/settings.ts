import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Price } from "../model/pricing.js";
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
 *   "env": { "allow": ["NODE_ENV"] },
 *   "limits": { "maxSteps": 50, "tokenBudget": 20000000 },
 *   "model": {
 *     "contextWindow": 200000,
 *     "price": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
 *   }
 * }
 */

export const SETTINGS_FILE = join(".garuda", "settings.json");

const schema = z.strictObject({
  executor: z.enum(EXECUTOR_NAMES).optional(),
  /** false: no code index tools for the model (the chat commands /where, /refs, /map stay). */
  codeIndex: z.boolean().optional(),
  permissions: z
    .strictObject({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  env: z.strictObject({ allow: z.array(z.string()).optional() }).optional(),
  limits: z
    .strictObject({
      maxSteps: z.number().int().min(1).max(1_000).optional(),
      tokenBudget: z.number().int().min(1_000).optional(),
    })
    .optional(),
  model: z
    .strictObject({
      contextWindow: z.number().int().min(10_000).optional(),
      /** USD per million tokens. */
      price: z
        .strictObject({
          input: z.number().min(0),
          output: z.number().min(0),
          cacheRead: z.number().min(0),
          cacheWrite: z.number().min(0),
        })
        .optional(),
    })
    .optional(),
});

export interface Settings {
  executor: (typeof EXECUTOR_NAMES)[number];
  allow: Rule[];
  deny: Rule[];
  /** Extra environment variables that commands may see. */
  envAllow: string[];
  codeIndex?: boolean;
  maxSteps?: number;
  tokenBudget?: number;
  contextWindow?: number;
  price?: Price;
}

export const DEFAULT_SETTINGS: Settings = { executor: "host", allow: [], deny: [], envAllow: [] };

export function parseSettings(json: unknown, source = SETTINGS_FILE): Settings {
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${source}: ${z.prettifyError(parsed.error)}`);
  const {
    executor = "host",
    permissions = {},
    env = {},
    limits = {},
    model = {},
    codeIndex,
  } = parsed.data;
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
    ...(codeIndex === undefined ? {} : { codeIndex }),
    ...(limits.maxSteps === undefined ? {} : { maxSteps: limits.maxSteps }),
    ...(limits.tokenBudget === undefined ? {} : { tokenBudget: limits.tokenBudget }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.price === undefined ? {} : { price: model.price }),
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
