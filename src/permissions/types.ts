import type { ExecPolicy, Isolation } from "../sandbox/types.js";

/** What a tool call acts on. Rules and the sensitive-path check match against it. */
export type CallTarget = PathTarget | CommandTarget | InputTarget | UrlTarget;

/** A file. `path` is relative to the root, with forward slashes. */
export interface PathTarget {
  kind: "path";
  path: string;
}

export interface CommandTarget {
  kind: "command";
  command: string;
  /** The model asks to run it outside the OS sandbox. It always needs approval or a rule. */
  outsideSandbox?: boolean;
}

/** A web address. Rules match the host: web_fetch(docs.python.org), web_fetch(*.github.com). */
export interface UrlTarget {
  kind: "url";
  url: string;
  host: string;
  /** Ask even when a rule or a session answer allows the host (an unusual URL). */
  alwaysAsk?: boolean;
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
  /** The question's header, when the default for the target kind does not fit (0.5, web_search). */
  title?: string;
}

export interface PermissionRequest {
  tool: string;
  readOnly: boolean;
  info?: CallInfo;
}

export type PermissionDecision =
  | { allowed: true; by: "read_only" | "sandbox" | "rule" | "session" | "user" }
  | { allowed: false; by: "rule" | "sensitive" | "user" | "unattended"; reason: string };

/** The permission check as the tools see it. The PermissionEngine implements it. */
export interface PermissionGate {
  check(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>;
  /** The policy for one command (N8). The engine builds it. */
  execPolicy(timeoutMs: number, options?: { sandbox?: boolean }): ExecPolicy;
}

/**
 * The agent's mode (0.4). In plan mode the agent reads and plans: calls that change files or
 * memory are denied, and commands run in a sandbox that cannot write the project.
 */
export type AgentMode = "build" | "plan";

// Approval (F18).

export type ApprovalChoice = "once" | "session" | "deny";

export interface ApprovalRequest {
  tool: string;
  target: CallTarget;
  preview: string;
  /** Isolation of the executor. Shown with commands, so the user knows they run on the host. */
  isolation: Isolation;
  /** A header that replaces the default one (for example, the MCP server consent). */
  title?: string;
  /** The question above the choices. Default: "Allow?". */
  question?: string;
  /** The choices to show, in this order. Default: once, session, deny. */
  choices?: readonly ApprovalChoice[];
  /** Labels that replace the default choice labels. */
  labels?: Partial<Record<ApprovalChoice, string>>;
}

/** Asks the user. The CLI implements it with a prompt. Tests use AutoApprover. */
export interface Approver {
  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalChoice>;
}
