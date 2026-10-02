import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TeamPolicy } from "../permissions/policy.js";
import type { CallTarget } from "../permissions/types.js";
import { Redactor } from "../session/redact.js";

/**
 * The audit log (0.17; reworked for the merge gate). Where: ~/.garuda/audit/<project>-<hash>/, one
 * file per Garuda process (`<time>-<pid>-<random>.jsonl`), so parallel jobs never share a file. Not in
 * the project: there the agent's own tools could change it, and a job's worktree (with its log) is
 * deleted after the job.
 *
 * Each line carries `seq`, `prev` (the hash of the line before; 64 zeros for the first) and `hash`
 * (sha256 of the line without `hash`). A changed, removed or inserted line breaks the chain, and
 * `verifyAuditFile` names the first broken line. This makes the log tamper-EVIDENT, not tamper-proof:
 * someone who can write the file can also rewrite the whole chain.
 *
 * Targets and reasons go through the session redactor first, so tokens and keys never reach disk.
 */
export const AUDIT_DIR = join(".garuda", "audit");
/** Where 0.17 wrote the log. Kept out of job commits and undo snapshots for old checkouts. */
export const LEGACY_AUDIT_FILE = join(".garuda", "audit.jsonl");
const GENESIS = "0".repeat(64);

/** The audit folder of a project: ~/.garuda/audit/<name>-<first 8 hex of sha256(root)>. */
export function auditDirFor(root: string, home: string = homedir()): string {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  const name = basename(root).replace(/[^A-Za-z0-9._-]/g, "_") || "root";
  return join(home, AUDIT_DIR, `${name}-${hash}`);
}

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

/** A line on disk: the event and its place in the hash chain. */
export type AuditLine = AuditEvent & { seq: number; prev: string; hash: string };

export interface AuditLoggerOptions {
  policy?: TeamPolicy;
  level?: "all" | "mutations" | "denials";
  enabled?: boolean;
  /**
   * A write failure throws (the call that caused the event fails). Default: true when the team
   * policy sets `audit.enabled: true`, else false: the first failure goes to `onError` once.
   */
  mandatory?: boolean;
  onError?: (message: string) => void;
  /** For the redactor. Default: this process's environment. */
  env?: NodeJS.ProcessEnv;
}

/** sha256 over the line without its own hash. */
export function auditLineHash(line: Omit<AuditLine, "hash">): string {
  return createHash("sha256").update(JSON.stringify(line)).digest("hex");
}

export class AuditLogger {
  /** The folder of this project's audit files. */
  readonly dir: string;
  /** This process's file. */
  readonly filePath: string;
  private readonly level: "all" | "mutations" | "denials";
  private readonly enabled: boolean;
  private readonly mandatory: boolean;
  private readonly onError: ((message: string) => void) | undefined;
  private readonly redactor: Redactor;
  private currentSessionId: string | undefined;
  private dirCreated = false;
  private seq = 0;
  private prev = GENESIS;
  private failed = false;
  /** Writes run one after another, so `seq` and `prev` follow the file order. */
  private queue: Promise<void> = Promise.resolve();

  /** `dir`: the project's audit folder (see auditDirFor). */
  constructor(dir: string, options: AuditLoggerOptions = {}) {
    this.dir = dir;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    this.filePath = join(dir, `${stamp}-${process.pid}-${randomBytes(3).toString("hex")}.jsonl`);
    this.level = options.level ?? options.policy?.audit?.level ?? "all";
    this.enabled = options.enabled ?? options.policy?.audit?.enabled ?? true;
    this.mandatory = options.mandatory ?? options.policy?.audit?.enabled === true;
    this.onError = options.onError;
    this.redactor = new Redactor(options.env);
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
      ...(event.target !== undefined ? { target: this.redactor.text(event.target) } : {}),
      decision: event.decision,
      allowed: event.allowed,
      ...(event.reason !== undefined ? { reason: this.redactor.text(event.reason) } : {}),
      risk: event.risk,
      ...(event.userChoice !== undefined ? { userChoice: event.userChoice } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.isError !== undefined ? { isError: event.isError } : {}),
    };
    const write = this.queue.then(() => this.append(fullEvent));
    // The queue goes on after a failure; the caller sees the failure (mandatory) or a notice.
    this.queue = write.catch(() => {});
    await write;
  }

  private async append(event: AuditEvent): Promise<void> {
    const body = { ...event, seq: this.seq + 1, prev: this.prev };
    const hash = auditLineHash(body);
    try {
      if (!this.dirCreated) {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        this.dirCreated = true;
      }
      await appendFile(this.filePath, `${JSON.stringify({ ...body, hash })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error) {
      const message = `The audit log could not be written (${this.filePath}): ${(error as Error).message}`;
      if (this.mandatory) throw new Error(message);
      if (!this.failed) {
        this.failed = true;
        this.onError?.(`${message}. Garuda goes on without it.`);
      }
      return;
    }
    this.seq = body.seq;
    this.prev = hash;
  }

  /** The audit files of this project, oldest first. */
  async files(): Promise<string[]> {
    try {
      return (await readdir(this.dir))
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .map((f) => join(this.dir, f));
    } catch {
      return [];
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
    let content = "";
    for (const file of await this.files()) {
      try {
        content += await readFile(file, "utf8");
      } catch {
        // A file removed while reading: skip it.
      }
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

/** Check one audit file's hash chain. `ok: false` names the first bad line (1-based). */
export async function verifyAuditFile(
  file: string,
): Promise<{ ok: true; lines: number } | { ok: false; line: number; why: string }> {
  const rows = (await readFile(file, "utf8")).split("\n").filter((l) => l !== "");
  let prev = GENESIS;
  for (let i = 0; i < rows.length; i++) {
    let line: AuditLine;
    try {
      line = JSON.parse(rows[i] as string) as AuditLine;
    } catch {
      return { ok: false, line: i + 1, why: "not JSON" };
    }
    if (line.seq !== i + 1)
      return { ok: false, line: i + 1, why: `seq ${line.seq}, expected ${i + 1}` };
    if (line.prev !== prev)
      return { ok: false, line: i + 1, why: "prev is not the hash of the line before" };
    const { hash, ...body } = line;
    if (auditLineHash(body) !== hash)
      return { ok: false, line: i + 1, why: "the hash does not match the line" };
    prev = hash;
  }
  return { ok: true, lines: rows.length };
}
