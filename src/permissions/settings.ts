import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { FormatterSetting } from "../format/formatters.js";
import type { CodeIndexMode } from "../knowledge/mode.js";
import type { Price } from "../model/pricing.js";
import { EFFORTS, type Effort } from "../model/types.js";
import { expandAllowlist } from "../net/allowlist.js";
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
 *   "subagents": { "enabled": true, "maxSteps": 20, "tokenBudget": 150000 },
 *   "todo": { "enabled": true },
 *   "lsp": { "enabled": true },
 *   "undo": { "enabled": false },
 *   "skills": { "enabled": false },
 *   "agents": { "enabled": false },
 *   "model": {
 *     "contextWindow": 200000,
 *     "price": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
 *   }
 * }
 */

export const SETTINGS_FILE = join(".garuda", "settings.json");

/** How the chat tells the user that it waits or is done (0.6). "auto" picks from TERM_PROGRAM. */
export const NOTIFY_CHOICES = ["auto", "osc9", "bell", "off"] as const;
export type NotifyChoice = (typeof NOTIFY_CHOICES)[number];

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
  /** The network allowlist for sandboxed commands (0.13): presets (npm, pypi …) or hosts. */
  network: z.strictObject({ allow: z.array(z.string()).optional() }).optional(),
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
  /** The todo_write tool (0.4). enabled: default false. */
  todo: z.strictObject({ enabled: z.boolean().optional() }).optional(),
  /** Undo snapshots before each turn (0.4). enabled: default true. */
  undo: z.strictObject({ enabled: z.boolean().optional() }).optional(),
  /** Skills (0.5). enabled: default true (the skill tool appears only when skills exist). */
  skills: z.strictObject({ enabled: z.boolean().optional() }).optional(),
  /** Custom agents (0.5). enabled: default true (the agent tool appears only when agents exist). */
  agents: z.strictObject({ enabled: z.boolean().optional() }).optional(),
  /**
   * Notifications in the chat (0.6): when an approval waits, and when a turn that ran at least
   * `afterSeconds` (default 10) ends. channel: default "auto". GARUDA_NOTIFY overrides the channel.
   */
  notifications: z
    .strictObject({
      channel: z.enum(NOTIFY_CHOICES).optional(),
      afterSeconds: z.number().int().min(0).max(86_400).optional(),
    })
    .optional(),
  /** Language server diagnostics after edits (0.4). enabled: default false. */
  lsp: z.strictObject({ enabled: z.boolean().optional() }).optional(),
  /**
   * The project's formatter after edits (0.10). enabled: default false (A/B first). commands: by
   * name, false turns a detected formatter off; a command adds one or replaces a detected one.
   */
  formatters: z
    .strictObject({
      enabled: z.boolean().optional(),
      commands: z
        .record(
          z.string().regex(/^[a-z][a-z0-9-]*$/),
          z.union([
            z.literal(false),
            z.strictObject({
              extensions: z.array(z.string().min(1)).min(1),
              command: z.array(z.string().min(1)).min(1),
            }),
          ]),
        )
        .optional(),
    })
    .optional(),
  /**
   * Claude's thinking (0.9). keepBlocks: send thinking blocks back (default true, as the API asks);
   * false is for A/B runs only. enabled, effort, show: the start value of /thinking.
   */
  thinking: z
    .strictObject({
      keepBlocks: z.boolean().optional(),
      enabled: z.boolean().optional(),
      effort: z.enum(EFFORTS).optional(),
      show: z.boolean().optional(),
    })
    .optional(),
  /** The explore subagent (0.3). enabled: default false. Limits per explore run. */
  subagents: z
    .strictObject({
      enabled: z.boolean().optional(),
      maxSteps: z.number().int().min(1).max(200).optional(),
      tokenBudget: z.number().int().min(10_000).optional(),
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
  /** The network allowlist (0.13): presets and hosts that sandboxed commands may reach. */
  network?: { allow: string[] };
  sandbox?: SandboxSettings;
  web?: { enabled: boolean; allowLocalhost: boolean };
  codeIndex?: CodeIndexMode;
  maxSteps?: number;
  tokenBudget?: number;
  contextWindow?: number;
  price?: Price;
  subagents?: { enabled?: boolean; maxSteps?: number; tokenBudget?: number };
  todo?: { enabled: boolean };
  lsp?: { enabled: boolean };
  undo?: { enabled: boolean };
  skills?: { enabled: boolean };
  agents?: { enabled: boolean };
  notifications?: { channel?: NotifyChoice; afterSeconds?: number };
  thinking?: { keepBlocks?: boolean; enabled?: boolean; effort?: Effort; show?: boolean };
  formatters?: { enabled: boolean; commands: Record<string, FormatterSetting> };
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
    subagents,
    todo,
    lsp,
    undo,
    skills,
    agents,
    notifications,
    thinking,
    formatters,
    network,
  } = parsed.data;
  const networkProblems = expandAllowlist(network?.allow ?? []).problems;
  if (networkProblems.length > 0) {
    throw new Error(`${source}: network.allow: ${networkProblems.join(" ")}`);
  }
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
    ...(network?.allow === undefined || network.allow.length === 0
      ? {}
      : { network: { allow: network.allow } }),
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
    ...(todo?.enabled === undefined ? {} : { todo: { enabled: todo.enabled } }),
    ...(lsp?.enabled === undefined ? {} : { lsp: { enabled: lsp.enabled } }),
    ...(undo?.enabled === undefined ? {} : { undo: { enabled: undo.enabled } }),
    ...(skills?.enabled === undefined ? {} : { skills: { enabled: skills.enabled } }),
    ...(agents?.enabled === undefined ? {} : { agents: { enabled: agents.enabled } }),
    ...(formatters === undefined
      ? {}
      : {
          formatters: {
            enabled: formatters.enabled ?? false,
            commands: formatters.commands ?? {},
          },
        }),
    ...(thinking === undefined
      ? {}
      : {
          thinking: {
            ...(thinking.keepBlocks === undefined ? {} : { keepBlocks: thinking.keepBlocks }),
            ...(thinking.enabled === undefined ? {} : { enabled: thinking.enabled }),
            ...(thinking.effort === undefined ? {} : { effort: thinking.effort }),
            ...(thinking.show === undefined ? {} : { show: thinking.show }),
          },
        }),
    ...(notifications === undefined
      ? {}
      : {
          notifications: {
            ...(notifications.channel === undefined ? {} : { channel: notifications.channel }),
            ...(notifications.afterSeconds === undefined
              ? {}
              : { afterSeconds: notifications.afterSeconds }),
          },
        }),
    ...(subagents === undefined
      ? {}
      : {
          subagents: {
            ...(subagents.enabled === undefined ? {} : { enabled: subagents.enabled }),
            ...(subagents.maxSteps === undefined ? {} : { maxSteps: subagents.maxSteps }),
            ...(subagents.tokenBudget === undefined ? {} : { tokenBudget: subagents.tokenBudget }),
          },
        }),
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
