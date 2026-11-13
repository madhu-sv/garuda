import { homedir } from "node:os";
import { join, sep } from "node:path";
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
import { hiddenPlaces, NEEDED_MODE_DENY, neededReads, type ReadsMode, shortPath } from "./reads.js";
import { formatRule, type Rule, ruleMatches } from "./rules.js";
import { expandPath, gradleDaemonPaths, policyDeniedPaths, sandboxPaths } from "./sandboxPaths.js";
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
import { prepareWriteScope, scopeDenial, scopePaths } from "./writeScope.js";

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
  /** The home folder for "needed" reads (T15). Default: the user's. Tests give a fake one. */
  home?: string;
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
  /**
   * T15: false turns off the question after a blocked read (`allowReads` allows nothing). Evals set
   * it: their approver answers every question with yes, and a yes would let a repo task read the
   * user's checkout, which holds the answer. Default true.
   */
  readQuestions?: boolean;
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
  private readonly home: string;
  private readonly readQuestions: boolean;
  /** T15 step 2: paths that the user let commands read for this session ("needed" mode). */
  private readonly sessionReadPaths = new Set<string>();
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
    this.home = options.home ?? homedir();
    this.readQuestions = options.readQuestions ?? true;
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
    // A scheduled job (unattended, or with a write scope) never runs a command outside the OS
    // sandbox, whatever the rules say (second review of 0.17: an allow rule let `outside_sandbox`
    // run, with no write scope and no sandbox).
    if (
      target?.kind === "command" &&
      target.outsideSandbox === true &&
      (this.unattended !== undefined || this.settings.writeScope !== undefined)
    ) {
      this.unattended?.onDeny?.(tool, target);
      return {
        decision: {
          allowed: false,
          by: "rule",
          reason:
            "A scheduled job runs commands only in the OS sandbox: outside_sandbox is not allowed. Do not retry it; list it in your final answer as work left for the user.",
        },
      };
    }
    // A job's write scope (0.17, T6): an edit outside it is denied, also when an allow rule or a
    // session rule matches. The path as named and the place it reaches through symbolic links must
    // both be in the scope (second review). A job reports it with its other denied calls. An edit
    // that no rule allows gets the job's usual denial below.
    const scope = this.settings.writeScope;
    const ruled =
      (allowRule !== undefined && !(target?.kind === "url" && target.alwaysAsk === true)) ||
      this.sessionRules.some((r) => ruleMatches(r, tool, target, "allow"));
    if (
      scope !== undefined &&
      target?.kind === "path" &&
      (ruled || this.unattended === undefined)
    ) {
      const outside = await scopeDenial(this.root, target.path, scope);
      if (outside !== undefined) {
        this.unattended?.onDeny?.(tool, target);
        return {
          decision: {
            allowed: false,
            by: "rule",
            reason: `${outside}. Do not retry it; list it in your final answer as work left for the user.`,
          },
        };
      }
    }
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
        ...(info?.change === undefined ? {} : { change: info.change }),
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
    return {
      decision: {
        allowed: true,
        by: "user",
        ...(choice === "session" ? { remembered: true } : {}),
      },
      userChoice: choice,
    };
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
   * After a command in "needed" mode could not read these paths (T15 step 2): ask the user, once
   * per path, to let commands read it for this session. Returns the allowed paths; the next
   * command's policy has them. No question in a job or an eval (nobody answers), for the whole
   * home folder, or for a hidden place itself.
   */
  async allowReads(paths: readonly string[], signal: AbortSignal): Promise<string[]> {
    const home = this.home;
    const allowed: string[] = [];
    for (const path of paths) {
      if (this.sessionReadPaths.has(path)) {
        allowed.push(path);
        continue;
      }
      if (!this.readQuestions || this.unattended !== undefined) continue;
      if (path === home || hiddenPlaces().includes(path)) continue;
      const shown = shortPath(path, home);
      const target = { kind: "path" as const, path };
      const choice = await this.approver.ask(
        {
          tool: "sandbox_read",
          target,
          title: `Let commands read ${shown}?`,
          question: `Let commands read ${shown} in this session?`,
          preview: `A command in the sandbox could not read ${shown}: in this project commands read only where needed ("sandbox.reads": "needed").`,
          choices: ["session", "deny"],
          defaultChoice: "deny",
          isolation: this.isolation,
        },
        signal,
      );
      await this.auditLogger?.logPermissionDecision({
        tool: "sandbox_read",
        target,
        readOnly: true,
        decision:
          choice === "deny"
            ? { allowed: false, by: "user", reason: "The user did not let commands read it." }
            : { allowed: true, by: "user" },
        userChoice: choice,
      });
      if (choice === "deny") continue;
      this.sessionReadPaths.add(path);
      allowed.push(path);
    }
    return allowed;
  }

  /**
   * The read mode of sandboxed commands (T15): the team policy's `requireNeededReads` wins, else
   * the settings' `sandbox.reads`, else "needed" (the default since 0.20.0, after the measurement
   * in docs/lld/reads.md). A project's "open" needs the user's yes (projectSettings.ts).
   */
  readsMode(): ReadsMode {
    if (this.policy?.requireNeededReads === true) return "needed";
    return this.settings.sandbox?.reads ?? "needed";
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
    const inRoot = (p: string) => p === this.root || p.startsWith(`${this.root}${sep}`);
    if (readOnlyRoot) {
      // The root is also a read-only hole, for a project inside a writable folder (a temp dir).
      writePaths = writePaths.filter((p) => !inRoot(p));
      denyWritePaths = [this.root, ...denyWritePaths];
    }
    // A job's write scope (0.17, T6): in the root, only the scope's paths are writable. Writable
    // paths outside the root (temp, caches, the job's linked folders) stay as they are.
    const scope =
      !readOnlyRoot && sandbox && this.settings.writeScope !== undefined
        ? { root: this.root, paths: scopePaths(this.root, this.settings.writeScope) }
        : undefined;
    if (scope !== undefined) {
      writePaths = writePaths.filter((p) => !inRoot(p));
      // Folder entries must exist for bubblewrap to bind them; a clean (`git clean -fd` after the
      // tests before the job) removes empty ones. A link or a path out of the worktree stops the
      // command.
      const problem = prepareWriteScope(this.root, this.settings.writeScope ?? []);
      if (problem !== undefined)
        throw new Error(`The job's write scope cannot be used: ${problem}.`);
    }
    // Reads only where needed (T15): the scope, and the mixed credential files denied (decision 3).
    const home = this.home;
    const readPaths = [
      ...(this.settings.sandbox?.readPaths ?? []).map((p) => expandPath(this.root, home, p)),
      ...this.sessionReadPaths,
    ];
    const reads =
      sandbox && this.readsMode() === "needed"
        ? neededReads({ home, root: this.root, writePaths, readPaths })
        : undefined;
    // A file that `readPaths` names comes back: that is how a build that needs one gets it.
    const named = (file: string) =>
      readPaths.some((p) => file === p || file.startsWith(`${p}${sep}`));
    const neededDenials =
      reads === undefined
        ? []
        : NEEDED_MODE_DENY.map((p) => join(home, p)).filter((file) => !named(file));
    return {
      root: this.root,
      sandbox,
      ...paths,
      denyReadPaths: [...paths.denyReadPaths, ...neededDenials, ...denied],
      ...(reads === undefined ? {} : { reads }),
      // The same home folder as sandboxPaths, which makes the registry writable (T14).
      ...(sandbox ? { gradleRegistry: gradleDaemonPaths(homedir()).registry } : {}),
      writePaths,
      ...(scope === undefined ? {} : { writeScope: scope }),
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

  /**
   * Why a write to this path is outside the job's write scope, or undefined (no scope, or inside
   * it). Write tools call it again just before they write (second review of 0.17): a link can
   * change between the permission check and the write.
   */
  async writeScopeDenial(path: string): Promise<string | undefined> {
    const scope = this.settings.writeScope;
    return scope === undefined ? undefined : scopeDenial(this.root, path, scope);
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
    // Open reads (T15, as for MCP servers): Garuda starts the server, not the model, and servers
    // live anywhere (~/.garuda/lsp, Garuda's own node_modules, a JDK). With "needed" reads as the
    // default, every language server test failed on CI, where the checkout is in the home folder.
    // The deny list still applies.
    const { proxy: _proxy, reads: _reads, ...policy } = this.execPolicy(0, { readOnlyRoot: true });
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
