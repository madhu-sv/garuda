import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { commandMatches, commandParts, hostMatches, pathMatches } from "./rules.js";

/**
 * Team policy (0.17; location fixed for the merge gate). The policy comes from places that a project
 * cannot write: the managed file (an admin writes it) and the user's own file. A project's
 * `.garuda/policy.json` is NOT read: a cloned repo could otherwise remove or loosen its own limits,
 * and the file is gitignored, so a job worktree never had it.
 *
 *   managed  /Library/Application Support/Garuda/policy.json (macOS), /etc/garuda/policy.json (Linux)
 *   user     ~/.garuda/policy.json
 */
export const POLICY_FILE = join(".garuda", "policy.json");

/** The managed policy file for a platform, or undefined where Garuda knows none. */
export function managedPolicyPath(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "darwin") return "/Library/Application Support/Garuda/policy.json";
  if (platform === "linux") return "/etc/garuda/policy.json";
  return undefined;
}

/** A project file that Garuda ignores, for a notice. */
export function ignoredProjectPolicy(root: string): string | undefined {
  const file = join(root, POLICY_FILE);
  return existsSync(file) ? file : undefined;
}

/** The team policy with the files it came from (managed first), for messages. */
export interface LoadedPolicy {
  policy: TeamPolicy;
  sources: string[];
}

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

/** Read and parse one policy file; undefined when it does not exist. Errors name the file. */
async function readPolicyFile(file: string): Promise<TeamPolicy | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${file}: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: invalid JSON: ${(error as Error).message}`);
  }
  try {
    return parsePolicy(json);
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
}

/**
 * Merge the user's and the managed policy (pure). The stricter value wins everywhere: lists of
 * denials add up, flags that restrict are on when either sets them, limits take the lower value.
 * `allowedModels` and `audit` come from the managed file when it sets them, else the user's.
 */
export function mergePolicies(
  user: TeamPolicy | undefined,
  managed: TeamPolicy | undefined,
): TeamPolicy | undefined {
  if (user === undefined) return managed;
  if (managed === undefined) return user;
  const union = (a?: string[], b?: string[]) =>
    a === undefined && b === undefined ? undefined : [...new Set([...(a ?? []), ...(b ?? [])])];
  const either = (a?: boolean, b?: boolean) =>
    a === undefined && b === undefined ? undefined : a === true || b === true;
  const lower = (a?: number, b?: number) =>
    a === undefined ? b : b === undefined ? a : Math.min(a, b);
  const disallowedCommands = union(user.disallowedCommands, managed.disallowedCommands);
  const denyPaths = union(user.denyPaths, managed.denyPaths);
  const requireSandbox = either(user.requireSandbox, managed.requireSandbox);
  const allowedModels = managed.allowedModels ?? user.allowedModels;
  const blockedHosts = union(user.network?.blockedHosts, managed.network?.blockedHosts);
  const strictAllowlist = either(user.network?.strictAllowlist, managed.network?.strictAllowlist);
  const maxSteps = lower(user.limits?.maxSteps, managed.limits?.maxSteps);
  const tokenBudget = lower(user.limits?.tokenBudget, managed.limits?.tokenBudget);
  const audit = managed.audit ?? user.audit;
  return {
    ...(disallowedCommands === undefined ? {} : { disallowedCommands }),
    ...(requireSandbox === undefined ? {} : { requireSandbox }),
    ...(denyPaths === undefined ? {} : { denyPaths }),
    ...(allowedModels === undefined ? {} : { allowedModels }),
    ...(blockedHosts === undefined && strictAllowlist === undefined
      ? {}
      : {
          network: {
            ...(blockedHosts === undefined ? {} : { blockedHosts }),
            ...(strictAllowlist === undefined ? {} : { strictAllowlist }),
          },
        }),
    ...(maxSteps === undefined && tokenBudget === undefined
      ? {}
      : {
          limits: {
            ...(maxSteps === undefined ? {} : { maxSteps }),
            ...(tokenBudget === undefined ? {} : { tokenBudget }),
          },
        }),
    ...(audit === undefined ? {} : { audit }),
  };
}

/**
 * Load the team policy from the managed file and ~/.garuda/policy.json. Undefined when neither
 * exists. A file that exists but cannot be read or parsed is an error (fail closed). Only the CLI
 * calls this with the defaults; tests pass their own `home` and `managed`.
 */
export async function loadTeamPolicy(
  options: { home?: string; managed?: string | undefined } = {},
): Promise<LoadedPolicy | undefined> {
  const userFile = join(options.home ?? homedir(), POLICY_FILE);
  const managedFile = "managed" in options ? options.managed : managedPolicyPath();
  const user = await readPolicyFile(userFile);
  const managed = managedFile === undefined ? undefined : await readPolicyFile(managedFile);
  const policy = mergePolicies(user, managed);
  if (policy === undefined) return undefined;
  const sources = [
    ...(managed === undefined || managedFile === undefined ? [] : [managedFile]),
    ...(user === undefined ? [] : [userFile]),
  ];
  return { policy, sources };
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
      reason:
        "The team policy requires the OS sandbox: this command would run outside it (outside_sandbox, or no sandbox on this machine).",
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

/** Reject before constructing a provider client, for both parent and child model selection. */
export function assertModelAllowedByPolicy(policy: TeamPolicy | undefined, modelId: string): void {
  if (policy === undefined) return;
  const decision = isModelAllowedByPolicy(policy, modelId);
  if (!decision.allowed) {
    throw new Error(decision.reason ?? `Model "${modelId}" is not permitted by team policy.`);
  }
}

export function isHostBlockedByPolicy(
  policy: TeamPolicy,
  host: string,
): { blocked: boolean; pattern?: string; reason?: string } {
  if (!policy.network?.blockedHosts || policy.network.blockedHosts.length === 0) {
    return { blocked: false };
  }
  // "Blocked.Test." and "blocked.test" are the same host (hostMatches ignores case).
  const name = host.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  for (const pattern of policy.network.blockedHosts) {
    if (hostMatches(pattern, name)) {
      return {
        blocked: true,
        pattern,
        reason: `Network access to host "${host}" is blocked by team policy: pattern "${pattern}".`,
      };
    }
  }
  return { blocked: false };
}
