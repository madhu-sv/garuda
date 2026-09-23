import type { ExecPolicy, Isolation } from "../sandbox/types.js";

/** What a tool call acts on. Rules and the sensitive-path check match against it. */
export type CallTarget = PathTarget | CommandTarget | InputTarget;

/** A file. `path` is relative to the root, with forward slashes. */
export interface PathTarget {
  kind: "path";
  path: string;
}

export interface CommandTarget {
  kind: "command";
  command: string;
}

/** A tool with no describe(): its input as JSON. Only bare `tool` rules match it. */
export interface InputTarget {
  kind: "input";
  json: string;
}

/** A tool's description of one call, made before it runs. */
export interface CallInfo {
  target: CallTarget;
  /** What the user sees before approval: a diff or the command (F18). */
  preview?: string;
}

export interface PermissionRequest {
  tool: string;
  readOnly: boolean;
  info?: CallInfo;
}

export type PermissionDecision =
  | { allowed: true; by: "read_only" | "rule" | "session" | "user" }
  | { allowed: false; by: "rule" | "sensitive" | "user"; reason: string };

/** The permission check as the tools see it. The PermissionEngine implements it. */
export interface PermissionGate {
  check(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>;
  /** The policy for one command (N8). The engine builds it. */
  execPolicy(timeoutMs: number): ExecPolicy;
}

// Approval (F18).

export type ApprovalChoice = "once" | "session" | "deny";

export interface ApprovalRequest {
  tool: string;
  target: CallTarget;
  preview: string;
  /** Isolation of the executor. Shown with commands, so the user knows they run on the host. */
  isolation: Isolation;
}

/** Asks the user. The CLI implements it with a prompt. Tests use AutoApprover. */
export interface Approver {
  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalChoice>;
}
