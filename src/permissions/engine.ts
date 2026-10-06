import { sep } from "node:path";
import type { AuditLogger } from "../audit/logger.js";
import type { ProfileAccess } from "../lang/profiles.js";
import type { ExecPolicy, Isolation, NetworkProxyPolicy } from "../sandbox/types.js";
import { realRelative } from "./pathGuard.js";
import {
  isCommandDisallowedByPolicy,
  isHostBlockedByPolicy,
  isPathDeniedByPolicy,
  isSandboxRequiredByPolicy,
  type TeamPolicy,
} from "./policy.js";
import { formatRule, type Rule, ruleMatches } from "./rules.js";
import { policyDeniedPaths, sandboxPaths } from "./sandboxPaths.js";
import { isProtectedFromWrites, isSensitive } from "./sensitive.js";
import { DEFAULT_SETTINGS, type Settings } from "./settings.js";
import type {
  AgentMode,
  ApprovalChoice,
  Approver,
  CallTarget,
  PermissionDecision,
  PermissionGate,
  PermissionRequest,
} from "./types.js";

/** Environment variables that every command sees. Settings can add more. */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TZ",
];

export const DEFAULT_MAX_OUTPUT_BYTES = 30_000;

export interface PermissionEngineOptions {
  root: string;
  approver: Approver;
  settings?: Settings;
  policy?: TeamPolicy;
  auditLogger?: AuditLogger;
  /** Isolation of the executor in use. With an OS sandbox, commands inside it need no approval. */
  isolation?: Isolation;
  /** Package caches and environment variables for the project's language profiles (0.3). */
  access?: ProfileAccess;
  /** The mode of the current turn (0.4). Default: build. */
  mode?: () => AgentMode;
  /**
   * A run with nobody to ask (0.7: a scheduled job). A call that would ask is denied with this
   * reason instead, and `onDeny` records it for the job report.
   */
  unattended?: { reason: string; onDeny?: (tool: string, target: CallTarget) => void };
}

/** What the model reads when a job denies a call that its approval list does not cover (0.7). */
export const JOB_DENIAL =
  "This call is not in the approved list of this scheduled job, and nobody can approve it now. Do not retry it. Continue without it if you can, and list it in your final answer as work left for the user.";

/** What the model reads when plan mode blocks a call. */
export const PLAN_MODE_DENIAL =
  "Plan mode is on: this call would change something. Put the change in your plan instead; the user switches to build mode to carry it out.";

/**
 * The permission engine (F17–F20). Order of checks:
 *   1. Sensitive path, and no allow rule names it   → deny (F20)
 *   2. Write to a protected path (.git/)             → deny
 *   3. A deny rule matches                           → deny (deny always wins, F19)
 *   3b. Plan mode (0.4), a call that is not read-only → see planDecision (never asks)
 *   4. Read-only tool                                → allow (F17)
 *   5. A command in the OS sandbox                   → allow (0.2)
 *   6. An allow rule or a session rule matches       → allow
 *   7. Otherwise ask the user: once, session, deny   (F18); a job (0.7) denies instead
 */
/** The network proxy as the engine sees it (0.13). */
export interface NetworkHandle {
  policy: NetworkProxyPolicy;
  takeBlocked(): { host: string; port: number; reason: string }[];
}

export class PermissionEngine implements PermissionGate {
  private readonly root: string;
  private readonly approver: Approver;
  private readonly settings: Settings;
  private readonly policy: TeamPolicy | undefined;
  private readonly auditLogger: AuditLogger | undefined;
  private readonly isolation: Isolation;
  private readonly access: ProfileAccess;
  private readonly mode: () => AgentMode;
  private readonly unattended: PermissionEngineOptions["unattended"];
  private readonly sessionRules: Rule[] = [];
  /** The network proxy for sandboxed commands (0.13), when it runs. */
  private network: NetworkHandle | undefined;

  constructor(options: PermissionEngineOptions) {
    this.root = options.root;
    this.approver = options.approver;
    this.settings = options.settings ?? DEFAULT_SETTINGS;
    this.policy = options.policy;
    this.auditLogger = options.auditLogger;
    this.isolation = options.isolation ?? "none";
    this.access = options.access ?? { writePaths: [], envAllow: [] };
    this.mode = options.mode ?? (() => "build");
    this.unattended = options.unattended;
  }

  async check(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    const { decision, userChoice } = await this.evaluateCheck(request, signal);
    await this.auditLogger?.logPermissionDecision({
      tool: request.tool,
      ...(request.info?.target === undefined ? {} : { target: request.info.target }),
      readOnly: request.readOnly,
      decision,
      ...(userChoice === undefined ? {} : { userChoice }),
    });
    return decision;
  }

  private async evaluateCheck(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<{ decision: PermissionDecision; userChoice?: ApprovalChoice }> {
    const { tool, info } = request;
    const target = info?.target;
    const allowRule = this.settings.allow.find((r) => ruleMatches(r, tool, target, "allow"));

    // A symbolic link: the file it reaches gets the same denials as when it is named directly.
    if (target?.kind === "path") {
      const real = await realRelative(this.root, target.path);
      if (real !== undefined) {
        const denial = this.pathDenial(tool, { kind: "path", path: real }, request.readOnly);
        if (denial !== undefined) {
          return {
            decision: { ...denial, reason: `${target.path} leads to ${real}. ${denial.reason}` },
          };
        }
      }
    }

    if (this.policy !== undefined) {
      if (target?.kind === "command") {
        // With no OS sandbox (isolation "none") every command runs on the host, so a required
        // sandbox means no command at all (G03).
        const sandboxViolation = isSandboxRequiredByPolicy(
          this.policy,
          target.outsideSandbox === true || this.isolation === "none",
        );
        if (sandboxViolation.disallowed) {
          return {
            decision: {
              allowed: false,
              by: "policy",
              reason:
                sandboxViolation.reason ??
                "Running commands outside the sandbox is disallowed by team policy.",
            },
          };
        }
        const cmdViolation = isCommandDisallowedByPolicy(this.policy, target.command);
        if (cmdViolation.disallowed) {
          return {
            decision: {
              allowed: false,
              by: "policy",
              reason: cmdViolation.reason ?? "Command disallowed by team policy.",
            },
          };
        }
      }
      if (target?.kind === "path") {
        const pathViolation = isPathDeniedByPolicy(this.policy, target.path);
        if (pathViolation.denied) {
          return {
            decision: {
              allowed: false,
              by: "policy",
              reason: pathViolation.reason ?? "Path disallowed by team policy.",
            },
          };
        }
      }
      if (target?.kind === "url") {
        const hostViolation = isHostBlockedByPolicy(this.policy, target.host);
        if (hostViolation.blocked) {
          return {
            decision: {
              allowed: false,
              by: "policy",
              reason: hostViolation.reason ?? "Host blocked by team policy.",
            },
          };
        }
        if (this.policy.network?.strictAllowlist === true && allowRule === undefined) {
          return {
            decision: {
              allowed: false,
              by: "policy",
              reason: `Host "${target.host}" is not on the network allowlist and strict policy prohibits user overrides.`,
            },
          };
        }
      }
    }

    if (target?.kind === "path" && isSensitive(target.path)) {
      // Only a rule with a pattern lifts the block. A bare "read_file" rule does not.
      const named = this.settings.allow.some(
        (r) => r.pattern !== undefined && ruleMatches(r, tool, target, "allow"),
      );
      if (!named) {
        return {
          decision: {
            allowed: false,
            by: "sensitive",
            reason: `${target.path} is a sensitive file. Add "${tool}(${target.path})" to permissions.allow in .garuda/settings.json to allow it.`,
          },
        };
      }
    }

    if (target?.kind === "path" && !request.readOnly && isProtectedFromWrites(target.path)) {
      return {
        decision: {
          allowed: false,
          by: "rule",
          reason: `${target.path} is inside .git/.`,
          kind: "protected",
        },
      };
    }

    const denyRule = this.settings.deny.find((r) => ruleMatches(r, tool, target, "deny"));
    if (denyRule !== undefined) {
      return {
        decision: {
          allowed: false,
          by: "rule",
          reason: `A deny rule blocks this call: ${formatRule(denyRule)}.`,
        },
      };
    }

    if (this.mode() === "plan" && !request.readOnly) {
      return { decision: this.planDecision(tool, target, allowRule !== undefined) };
    }

    if (request.readOnly) return { decision: { allowed: true, by: "read_only" } };
    if (target?.kind === "command" && !target.outsideSandbox && this.isolation !== "none") {
      return { decision: { allowed: true, by: "sandbox" } };
    }
    const mustAsk = target?.kind === "url" && target.alwaysAsk === true;
    if (allowRule !== undefined && !mustAsk) return { decision: { allowed: true, by: "rule" } };
    if (!mustAsk && this.sessionRules.some((r) => ruleMatches(r, tool, target, "allow"))) {
      return { decision: { allowed: true, by: "session" } };
    }

    const asked: CallTarget = target ?? { kind: "input", json: "{}" };
    if (this.unattended !== undefined) {
      this.unattended.onDeny?.(tool, asked);
      return { decision: { allowed: false, by: "unattended", reason: this.unattended.reason } };
    }
    let accepted: readonly number[] | undefined;
    const choice = await this.approver.ask(
      {
        tool,
        target: asked,
        preview: info?.preview ?? describeTarget(asked),
        isolation: this.isolation,
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        ...(info?.title === undefined ? {} : { title: info.title }),
        ...(info?.hunks === true
          ? {
              selectHunks: (hunks: readonly number[]) => {
                accepted = [...hunks];
              },
            }
          : {}),
      },
      signal,
    );
    if (choice === "deny") {
      return {
        decision: {
          allowed: false,
          by: "user",
          reason: "The user denied this call. Do not retry it. Ask the user what to do instead.",
        },
        userChoice: choice,
      };
    }
    if (choice === "session") this.sessionRules.push(sessionRule(tool, asked));
    // Some hunks only (U0): the tool applies exactly these. Never with "session".
    if (choice === "once" && accepted !== undefined) {
      return { decision: { allowed: true, by: "user", hunks: accepted }, userChoice: choice };
    }
    return { decision: { allowed: true, by: "user" }, userChoice: choice };
  }

  /**
   * Plan mode: file changes and memory are always denied; a command runs only in the OS sandbox
   * (which then cannot write the project, see execPolicy); other calls (web_fetch, MCP tools)
   * need an allow rule. Plan mode never asks: the plan is the place for changes.
   */
  private planDecision(
    tool: string,
    target: CallTarget | undefined,
    allowed: boolean,
  ): PermissionDecision {
    const deny: PermissionDecision = {
      allowed: false,
      by: "rule",
      reason: PLAN_MODE_DENIAL,
      kind: "plan",
    };
    if (target?.kind === "command") {
      if (target.outsideSandbox || this.isolation === "none") return deny;
      return { allowed: true, by: "sandbox" };
    }
    if (target?.kind === "path" || tool === "remember") return deny;
    const mustAsk = target?.kind === "url" && target.alwaysAsk === true;
    return allowed && !mustAsk ? { allowed: true, by: "rule" } : deny;
  }

  /** The denials that depend only on the path: team policy, sensitive files, .git, deny rules. */
  private pathDenial(
    tool: string,
    target: { kind: "path"; path: string },
    readOnly: boolean,
  ): Extract<PermissionDecision, { allowed: false }> | undefined {
    if (this.policy !== undefined) {
      const violation = isPathDeniedByPolicy(this.policy, target.path);
      if (violation.denied) {
        return {
          allowed: false,
          by: "policy",
          reason: violation.reason ?? "Denied by team policy.",
        };
      }
    }
    if (isSensitive(target.path)) {
      const named = this.settings.allow.some(
        (r) => r.pattern !== undefined && ruleMatches(r, tool, target, "allow"),
      );
      if (!named) {
        return { allowed: false, by: "sensitive", reason: `${target.path} is a sensitive file.` };
      }
    }
    if (!readOnly && isProtectedFromWrites(target.path)) {
      return {
        allowed: false,
        by: "rule",
        reason: `${target.path} is inside .git/.`,
        kind: "protected",
      };
    }
    const deny = this.settings.deny.find((r) => ruleMatches(r, tool, target, "deny"));
    if (deny !== undefined) {
      return {
        allowed: false,
        by: "rule",
        reason: `A deny rule blocks this call: ${formatRule(deny)}.`,
      };
    }
    return undefined;
  }

  commandPolicyDenial(command: string, outsideSandbox: boolean): string | undefined {
    if (this.policy === undefined) return undefined;
    const sandbox = isSandboxRequiredByPolicy(
      this.policy,
      outsideSandbox || this.isolation === "none",
    );
    if (sandbox.disallowed) {
      return sandbox.reason ?? "Running commands outside the sandbox is disallowed by team policy.";
    }
    const command_ = isCommandDisallowedByPolicy(this.policy, command);
    if (command_.disallowed) return command_.reason ?? "Command disallowed by team policy.";
    return undefined;
  }

  deniedByPolicy(path: string): boolean {
    return this.policy !== undefined && isPathDeniedByPolicy(this.policy, path).denied;
  }

  /**
   * The policy for one command. `readOnlyRoot` (plan mode, language servers): the project is
   * read-only; temp folders and package caches stay writable.
   */
  execPolicy(
    timeoutMs: number,
    {
      sandbox = true,
      readOnlyRoot = this.mode() === "plan",
    }: { sandbox?: boolean; readOnlyRoot?: boolean } = {},
  ): ExecPolicy {
    const paths = sandboxPaths(this.root, this.settings.sandbox);
    // The team policy's denied paths: no read and no write for commands either (K6).
    const denied = policyDeniedPaths(this.root, this.policy?.denyPaths ?? []);
    let writePaths = [...new Set([...paths.writePaths, ...this.access.writePaths])];
    let denyWritePaths = [...paths.denyWritePaths, ...denied];
    if (readOnlyRoot) {
      // The root is also a read-only hole, for a project inside a writable folder (a temp dir).
      const inRoot = (p: string) => p === this.root || p.startsWith(`${this.root}${sep}`);
      writePaths = writePaths.filter((p) => !inRoot(p));
      denyWritePaths = [this.root, ...denyWritePaths];
    }
    return {
      root: this.root,
      sandbox,
      ...paths,
      denyReadPaths: [...paths.denyReadPaths, ...denied],
      writePaths,
      denyWritePaths,
      network: !sandbox,
      ...(sandbox && this.network !== undefined ? { proxy: this.network.policy } : {}),
      envAllowlist: [
        ...new Set([...DEFAULT_ENV_ALLOWLIST, ...this.access.envAllow, ...this.settings.envAllow]),
      ],
      timeoutMs,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    };
  }

  /** The network allowlist (0.13): the runtime sets it when the proxy runs. */
  setNetwork(network: NetworkHandle | undefined): void {
    this.network = network;
  }

  takeNetworkBlocks(): { host: string; port: number; reason: string }[] {
    return this.network?.takeBlocked() ?? [];
  }

  /**
   * The policy for a language server (0.4): in the sandbox, project read-only, no network, no
   * time limit (it runs for the session).
   */
  serverPolicy(): ExecPolicy {
    // No network allowlist (0.13): a language server needs no downloads.
    const { proxy: _proxy, ...policy } = this.execPolicy(0, { readOnlyRoot: true });
    return { ...policy, maxOutputBytes: 0 };
  }
}

/**
 * "Allow for session" scope: all calls of a file tool, or this exact command.
 * A command pattern would be too wide: allowing `ls` must not allow `ls; rm -rf .`.
 */
function sessionRule(tool: string, target: CallTarget): Rule {
  if (target.kind === "command") return { tool, pattern: target.command, exact: true };
  // For a URL: this host, not its subdomains and not other hosts.
  if (target.kind === "url") return { tool, pattern: target.host };
  return { tool };
}

export function describeTarget(target: CallTarget): string {
  if (target.kind === "path") return target.path;
  if (target.kind === "command") {
    return target.outsideSandbox ? `[outside sandbox] ${target.command}` : target.command;
  }
  if (target.kind === "url") return target.url;
  return target.json;
}
