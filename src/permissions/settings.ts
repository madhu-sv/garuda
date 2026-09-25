import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CodeIndexMode } from "../knowledge/mode.js";
import type { Price } from "../model/pricing.js";
import { EXECUTOR_NAMES } from "../sandbox/index.js";
import { parseRule, type Rule } from "./rules.js";
import type { SandboxSettings } from "./sandboxPaths.js";

/**
 * Project settings: `.garuda/settings.json` in the working root (F19).
 *
 * {
 *   "executor": "auto",
 *   "sandbox": { "writePaths": ["~/tools/cache"], "denyRead": ["~/secrets"] },
 *   "permissions": {
 *     "allow": ["bash(pnpm test*)", "edit_file(src/**)"],
 *     "deny":  ["bash(rm -rf*)", "bash(git push*)"]
 *   },
 *   "env": { "allow": ["NODE_ENV"] },
 *   "web": { "enabled": true, "allowLocalhost": false },
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
  sandbox: z
    .strictObject({
      writePaths: z.array(z.string()).optional(),
      denyRead: z.array(z.string()).optional(),
    })
    .optional(),
  /** Code index tools for the model: "off", "lookup" or "all" (true = "all", false = "off"). */
  codeIndex: z.union([z.boolean(), z.enum(["off", "lookup", "all"])]).optional(),
  permissions: z
    .strictObject({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  env: z.strictObject({ allow: z.array(z.string()).optional() }).optional(),
  /** web_fetch. enabled: default true. allowLocalhost: default false (loopback only, never private ranges). */
  web: z
    .strictObject({ enabled: z.boolean().optional(), allowLocalhost: z.boolean().optional() })
    .optional(),
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
  sandbox?: SandboxSettings;
  web?: { enabled: boolean; allowLocalhost: boolean };
  codeIndex?: CodeIndexMode;
  maxSteps?: number;
  tokenBudget?: number;
  contextWindow?: number;
  price?: Price;
}

export const DEFAULT_SETTINGS: Settings = { executor: "auto", allow: [], deny: [], envAllow: [] };

export function parseSettings(json: unknown, source = SETTINGS_FILE): Settings {
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${source}: ${z.prettifyError(parsed.error)}`);
  const {
    executor = "auto",
    sandbox,
    web,
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
    ...(web === undefined
      ? {}
      : { web: { enabled: web.enabled ?? true, allowLocalhost: web.allowLocalhost ?? false } }),
    ...(sandbox === undefined
      ? {}
      : {
          sandbox: {
            ...(sandbox.writePaths === undefined ? {} : { writePaths: sandbox.writePaths }),
            ...(sandbox.denyRead === undefined ? {} : { denyRead: sandbox.denyRead }),
          },
        }),
    ...(codeIndex === undefined
      ? {}
      : { codeIndex: codeIndex === true ? "all" : codeIndex === false ? "off" : codeIndex }),
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
