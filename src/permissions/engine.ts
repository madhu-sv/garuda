import type { ExecPolicy, Isolation } from "../sandbox/types.js";
import { formatRule, type Rule, ruleMatches } from "./rules.js";
import { sandboxPaths } from "./sandboxPaths.js";
import { isProtectedFromWrites, isSensitive } from "./sensitive.js";
import { DEFAULT_SETTINGS, type Settings } from "./settings.js";
import type {
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
  /** Isolation of the executor in use. With an OS sandbox, commands inside it need no approval. */
  isolation?: Isolation;
}

/**
 * The permission engine (F17–F20). Order of checks:
 *   1. Sensitive path, and no allow rule names it   → deny (F20)
 *   2. Write to a protected path (.git/)             → deny
 *   3. A deny rule matches                           → deny (deny always wins, F19)
 *   4. Read-only tool                                → allow (F17)
 *   5. A command in the OS sandbox                   → allow (0.2)
 *   6. An allow rule or a session rule matches       → allow
 *   7. Otherwise ask the user: once, session, deny   (F18)
 */
export class PermissionEngine implements PermissionGate {
  private readonly root: string;
  private readonly approver: Approver;
  private readonly settings: Settings;
  private readonly isolation: Isolation;
  private readonly sessionRules: Rule[] = [];

  constructor(options: PermissionEngineOptions) {
    this.root = options.root;
    this.approver = options.approver;
    this.settings = options.settings ?? DEFAULT_SETTINGS;
    this.isolation = options.isolation ?? "none";
  }

  async check(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    const { tool, info } = request;
    const target = info?.target;
    const allowRule = this.settings.allow.find((r) => ruleMatches(r, tool, target, "allow"));

    if (target?.kind === "path" && isSensitive(target.path)) {
      // Only a rule with a pattern lifts the block. A bare "read_file" rule does not.
      const named = this.settings.allow.some(
        (r) => r.pattern !== undefined && ruleMatches(r, tool, target, "allow"),
      );
      if (!named) {
        return {
          allowed: false,
          by: "sensitive",
          reason: `${target.path} is a sensitive file. Add "${tool}(${target.path})" to permissions.allow in .garuda/settings.json to allow it.`,
        };
      }
    }

    if (target?.kind === "path" && !request.readOnly && isProtectedFromWrites(target.path)) {
      return { allowed: false, by: "rule", reason: `${target.path} is inside .git/.` };
    }

    const denyRule = this.settings.deny.find((r) => ruleMatches(r, tool, target, "deny"));
    if (denyRule !== undefined) {
      return {
        allowed: false,
        by: "rule",
        reason: `A deny rule blocks this call: ${formatRule(denyRule)}.`,
      };
    }

    if (request.readOnly) return { allowed: true, by: "read_only" };
    if (target?.kind === "command" && !target.outsideSandbox && this.isolation !== "none") {
      return { allowed: true, by: "sandbox" };
    }
    const mustAsk = target?.kind === "url" && target.alwaysAsk === true;
    if (allowRule !== undefined && !mustAsk) return { allowed: true, by: "rule" };
    if (!mustAsk && this.sessionRules.some((r) => ruleMatches(r, tool, target, "allow"))) {
      return { allowed: true, by: "session" };
    }

    const asked: CallTarget = target ?? { kind: "input", json: "{}" };
    const choice = await this.approver.ask(
      {
        tool,
        target: asked,
        preview: info?.preview ?? describeTarget(asked),
        isolation: this.isolation,
      },
      signal,
    );
    if (choice === "deny") {
      return {
        allowed: false,
        by: "user",
        reason: "The user denied this call. Do not retry it. Ask the user what to do instead.",
      };
    }
    if (choice === "session") this.sessionRules.push(sessionRule(tool, asked));
    return { allowed: true, by: "user" };
  }

  execPolicy(timeoutMs: number, { sandbox = true }: { sandbox?: boolean } = {}): ExecPolicy {
    return {
      root: this.root,
      sandbox,
      ...sandboxPaths(this.root, this.settings.sandbox),
      network: !sandbox,
      envAllowlist: [...new Set([...DEFAULT_ENV_ALLOWLIST, ...this.settings.envAllow])],
      timeoutMs,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    };
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

function describeTarget(target: CallTarget): string {
  if (target.kind === "path") return target.path;
  if (target.kind === "command") return target.command;
  if (target.kind === "url") return target.url;
  return target.json;
}
