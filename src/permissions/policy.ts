import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { commandMatches, commandParts, hostMatches, pathMatches } from "./rules.js";

export const POLICY_FILE = join(".garuda", "policy.json");

export interface TeamPolicy {
  /** Disallowed command patterns across all executions (e.g. ["rm -rf *", "git push *--force*"]). */
  disallowedCommands?: string[];
  /** Require OS sandbox for all bash commands (disallowing outsideSandbox: true). */
  requireSandbox?: boolean;
  /** Patterns of paths that may not be read or written, regardless of user settings. */
  denyPaths?: string[];
  /** Allowed models (if set, any model not matching at least one pattern is forbidden). */
  allowedModels?: string[];
  /** Network policy restrictions. */
  network?: {
    blockedHosts?: string[];
    strictAllowlist?: boolean;
  };
  /** Global limit overrides (cannot be exceeded by settings or CLI flags). */
  limits?: {
    maxSteps?: number;
    tokenBudget?: number;
  };
  /** Audit log configuration. */
  audit?: {
    enabled?: boolean;
    level?: "all" | "mutations" | "denials";
  };
}

const policySchema = z.strictObject({
  disallowedCommands: z.array(z.string()).optional(),
  requireSandbox: z.boolean().optional(),
  denyPaths: z.array(z.string()).optional(),
  allowedModels: z.array(z.string()).optional(),
  network: z
    .strictObject({
      blockedHosts: z.array(z.string()).optional(),
      strictAllowlist: z.boolean().optional(),
    })
    .optional(),
  limits: z
    .strictObject({
      maxSteps: z.number().int().positive().optional(),
      tokenBudget: z.number().int().positive().optional(),
    })
    .optional(),
  audit: z
    .strictObject({
      enabled: z.boolean().optional(),
      level: z.enum(["all", "mutations", "denials"]).optional(),
    })
    .optional(),
});

export function parsePolicy(json: unknown): TeamPolicy {
  const result = policySchema.safeParse(json);
  if (!result.success) {
    throw new Error(`Invalid policy schema: ${z.prettifyError(result.error)}`);
  }
  const data = result.data;
  return {
    ...(data.disallowedCommands === undefined
      ? {}
      : { disallowedCommands: data.disallowedCommands }),
    ...(data.requireSandbox === undefined ? {} : { requireSandbox: data.requireSandbox }),
    ...(data.denyPaths === undefined ? {} : { denyPaths: data.denyPaths }),
    ...(data.allowedModels === undefined ? {} : { allowedModels: data.allowedModels }),
    ...(data.network === undefined
      ? {}
      : {
          network: {
            ...(data.network.blockedHosts === undefined
              ? {}
              : { blockedHosts: data.network.blockedHosts }),
            ...(data.network.strictAllowlist === undefined
              ? {}
              : { strictAllowlist: data.network.strictAllowlist }),
          },
        }),
    ...(data.limits === undefined
      ? {}
      : {
          limits: {
            ...(data.limits.maxSteps === undefined ? {} : { maxSteps: data.limits.maxSteps }),
            ...(data.limits.tokenBudget === undefined
              ? {}
              : { tokenBudget: data.limits.tokenBudget }),
          },
        }),
    ...(data.audit === undefined
      ? {}
      : {
          audit: {
            ...(data.audit.enabled === undefined ? {} : { enabled: data.audit.enabled }),
            ...(data.audit.level === undefined ? {} : { level: data.audit.level }),
          },
        }),
  };
}

export async function loadPolicy(root: string): Promise<TeamPolicy | undefined> {
  let text: string;
  try {
    text = await readFile(join(root, POLICY_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${POLICY_FILE}: invalid JSON: ${(error as Error).message}`);
  }
  return parsePolicy(json);
}

export function isCommandDisallowedByPolicy(
  policy: TeamPolicy,
  command: string,
): { disallowed: boolean; pattern?: string; reason?: string } {
  if (!policy.disallowedCommands || policy.disallowedCommands.length === 0) {
    return { disallowed: false };
  }
  const parts = commandParts(command);
  for (const pattern of policy.disallowedCommands) {
    const hit = (part: string) => commandMatches(pattern, part);
    if (parts.some(hit) || hit(command)) {
      return {
        disallowed: true,
        pattern,
        reason: `Command is disallowed by team policy: pattern "${pattern}".`,
      };
    }
  }
  return { disallowed: false };
}

export function isSandboxRequiredByPolicy(
  policy: TeamPolicy,
  outsideSandbox: boolean,
): { disallowed: boolean; reason?: string } {
  if (policy.requireSandbox === true && outsideSandbox) {
    return {
      disallowed: true,
      reason: "Running commands outside the sandbox is disallowed by team policy.",
    };
  }
  return { disallowed: false };
}

export function isPathDeniedByPolicy(
  policy: TeamPolicy,
  path: string,
): { denied: boolean; pattern?: string; reason?: string } {
  if (!policy.denyPaths || policy.denyPaths.length === 0) {
    return { denied: false };
  }
  for (const pattern of policy.denyPaths) {
    if (pathMatches(pattern, path)) {
      return {
        denied: true,
        pattern,
        reason: `Access to path "${path}" is disallowed by team policy: pattern "${pattern}".`,
      };
    }
  }
  return { denied: false };
}

export function isModelAllowedByPolicy(
  policy: TeamPolicy,
  modelId: string,
): { allowed: boolean; reason?: string } {
  if (!policy.allowedModels || policy.allowedModels.length === 0) {
    return { allowed: true };
  }
  const allowed = policy.allowedModels.some((pattern) => commandMatches(pattern, modelId));
  if (!allowed) {
    return {
      allowed: false,
      reason: `Model "${modelId}" is not permitted by team policy. Allowed: ${policy.allowedModels.join(", ")}.`,
    };
  }
  return { allowed: true };
}

export function isHostBlockedByPolicy(
  policy: TeamPolicy,
  host: string,
): { blocked: boolean; pattern?: string; reason?: string } {
  if (!policy.network?.blockedHosts || policy.network.blockedHosts.length === 0) {
    return { blocked: false };
  }
  for (const pattern of policy.network.blockedHosts) {
    if (hostMatches(pattern, host)) {
      return {
        blocked: true,
        pattern,
        reason: `Network access to host "${host}" is blocked by team policy: pattern "${pattern}".`,
      };
    }
  }
  return { blocked: false };
}
