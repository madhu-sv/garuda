import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TeamPolicy } from "../permissions/policy.js";
import type { CallTarget } from "../permissions/types.js";

export const AUDIT_FILE = join(".garuda", "audit.jsonl");

export type AuditDecision =
  | "allow_readonly"
  | "allow_sandbox"
  | "allow_rule"
  | "allow_session"
  | "allow_user"
  | "deny_policy"
  | "deny_sensitive"
  | "deny_protected"
  | "deny_rule"
  | "deny_plan"
  | "deny_unattended"
  | "deny_user"
  | "executed"
  | "error";

export type AuditRisk = "low" | "medium" | "high" | "critical";

export interface AuditEvent {
  id: string;
  timestamp: string; // ISO 8601
  sessionId?: string;
  tool: string;
  target?: string;
  decision: AuditDecision;
  allowed: boolean;
  reason?: string;
  risk: AuditRisk;
  userChoice?: "once" | "session" | "deny";
  durationMs?: number;
  isError?: boolean;
}

export interface AuditLoggerOptions {
  policy?: TeamPolicy;
  level?: "all" | "mutations" | "denials";
  enabled?: boolean;
}

export class AuditLogger {
  private readonly root: string;
  private readonly filePath: string;
  private readonly level: "all" | "mutations" | "denials";
  private readonly enabled: boolean;
  private currentSessionId: string | undefined;
  private dirCreated = false;

  constructor(root: string, options: AuditLoggerOptions = {}) {
    this.root = root;
    this.filePath = join(root, AUDIT_FILE);
    this.level = options.level ?? options.policy?.audit?.level ?? "all";
    this.enabled = options.enabled ?? options.policy?.audit?.enabled ?? true;
  }

  setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  async log(
    event: Omit<AuditEvent, "id" | "timestamp"> & { id?: string; timestamp?: string },
  ): Promise<void> {
    if (!this.enabled) return;
    if (this.level === "denials" && event.allowed && !event.isError) return;
    if (this.level === "mutations" && event.risk === "low" && event.allowed) return;

    const fullEvent: AuditEvent = {
      id: event.id ?? `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: event.timestamp ?? new Date().toISOString(),
      ...(event.sessionId !== undefined
        ? { sessionId: event.sessionId }
        : this.currentSessionId !== undefined
          ? { sessionId: this.currentSessionId }
          : {}),
      tool: event.tool,
      ...(event.target !== undefined ? { target: event.target } : {}),
      decision: event.decision,
      allowed: event.allowed,
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
      risk: event.risk,
      ...(event.userChoice !== undefined ? { userChoice: event.userChoice } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.isError !== undefined ? { isError: event.isError } : {}),
    };

    try {
      if (!this.dirCreated) {
        await mkdir(join(this.root, ".garuda"), { recursive: true });
        this.dirCreated = true;
      }
      await appendFile(this.filePath, `${JSON.stringify(fullEvent)}\n`, "utf8");
    } catch {
      // Audit logging write failure must never crash the main application
    }
  }

  async logPermissionDecision(params: {
    tool: string;
    target?: CallTarget;
    readOnly?: boolean;
    decision: { allowed: boolean; by?: string; reason?: string };
    userChoice?: "once" | "session" | "deny";
  }): Promise<void> {
    const { tool, target, decision, userChoice } = params;
    let auditDecision: AuditDecision;
    let risk: AuditRisk = "low";

    if (decision.allowed) {
      if (decision.by === "read_only") {
        auditDecision = "allow_readonly";
        risk = "low";
      } else if (decision.by === "sandbox") {
        auditDecision = "allow_sandbox";
        risk = "medium";
      } else if (decision.by === "rule") {
        auditDecision = "allow_rule";
        risk = "medium";
      } else if (decision.by === "session") {
        auditDecision = "allow_session";
        risk = "medium";
      } else {
        auditDecision = "allow_user";
        risk = target?.kind === "command" && target.outsideSandbox ? "high" : "medium";
      }
    } else {
      if (decision.by === "policy") {
        auditDecision = "deny_policy";
        risk = "critical";
      } else if (decision.by === "sensitive") {
        auditDecision = "deny_sensitive";
        risk = "critical";
      } else if (decision.by === "rule") {
        if (decision.reason?.includes(".git")) {
          auditDecision = "deny_protected";
          risk = "critical";
        } else if (decision.reason?.includes("Plan mode")) {
          auditDecision = "deny_plan";
          risk = "medium";
        } else {
          auditDecision = "deny_rule";
          risk = "high";
        }
      } else if (decision.by === "unattended") {
        auditDecision = "deny_unattended";
        risk = "medium";
      } else {
        auditDecision = "deny_user";
        risk = "high";
      }
    }

    if (target?.kind === "url" || tool === "network" || tool === "web_fetch") {
      if (risk !== "critical") risk = "high";
    }

    const targetDesc = target ? describeTarget(target) : undefined;
    await this.log({
      tool,
      ...(targetDesc !== undefined ? { target: targetDesc } : {}),
      decision: auditDecision,
      allowed: decision.allowed,
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      risk,
      ...(userChoice !== undefined ? { userChoice } : {}),
    });
  }

  async logToolExecution(params: {
    tool: string;
    target?: CallTarget;
    durationMs: number;
    isError: boolean;
  }): Promise<void> {
    const { tool, target, durationMs, isError } = params;
    const targetDesc = target ? describeTarget(target) : undefined;
    await this.log({
      tool,
      ...(targetDesc !== undefined ? { target: targetDesc } : {}),
      decision: isError ? "error" : "executed",
      allowed: true,
      risk: isError ? "medium" : "low",
      durationMs,
      isError,
    });
  }

  async readEvents(
    options: { limit?: number; tool?: string; risk?: AuditRisk; denialsOnly?: boolean } = {},
  ): Promise<AuditEvent[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const events: AuditEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as AuditEvent;
        if (options.tool !== undefined && parsed.tool !== options.tool) continue;
        if (options.risk !== undefined && parsed.risk !== options.risk) continue;
        if (options.denialsOnly && parsed.allowed) continue;
        events.push(parsed);
      } catch {
        // Skip corrupted lines
      }
    }
    const limit = options.limit ?? 50;
    return events.slice(-limit).reverse();
  }

  async getStats(): Promise<{
    total: number;
    allowed: number;
    denied: number;
    policyBlocked: number;
    criticalCount: number;
  }> {
    const all = await this.readEvents({ limit: 100_000 });
    let allowed = 0;
    let denied = 0;
    let policyBlocked = 0;
    let criticalCount = 0;
    for (const e of all) {
      if (e.allowed) allowed++;
      else denied++;
      if (e.decision === "deny_policy") policyBlocked++;
      if (e.risk === "critical") criticalCount++;
    }
    return {
      total: all.length,
      allowed,
      denied,
      policyBlocked,
      criticalCount,
    };
  }
}

export function describeTarget(target: CallTarget): string {
  if (target.kind === "path") return target.path;
  if (target.kind === "command") {
    return target.outsideSandbox ? `[outside sandbox] ${target.command}` : target.command;
  }
  if (target.kind === "url") return target.url;
  return target.json;
}
