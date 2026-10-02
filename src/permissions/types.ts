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
  /**
   * The preview is a complete unified diff whose hunks the tool can apply one by one (edit_file).
   * The chat may then let the user accept some hunks; the tool gets them in `approvedHunks`.
   */
  hunks?: true;
}

export interface PermissionRequest {
  tool: string;
  readOnly: boolean;
  info?: CallInfo;
}

export type PermissionDecision =
  | {
      allowed: true;
      by: "read_only" | "sandbox" | "rule" | "session" | "user";
      /** The user accepted only these hunks of the preview (0-based, in diff order). */
      hunks?: readonly number[];
    }
  | { allowed: false; by: "rule" | "sensitive" | "user" | "unattended" | "policy"; reason: string };

/** The permission check as the tools see it. The PermissionEngine implements it. */
export interface PermissionGate {
  check(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>;
  /** The policy for one command (N8). The engine builds it. */
  execPolicy(timeoutMs: number, options?: { sandbox?: boolean }): ExecPolicy;
  /**
   * True when the team policy denies this root-relative path (`denyPaths`). Tools that read many
   * files (grep, glob, the code index) skip such files, so their content and names stay hidden (G04).
   * Required, so a wrapper (a subagent's gate) cannot drop the filter by mistake.
   */
  deniedByPolicy(path: string): boolean;
  /** The network allowlist (0.13): hosts that the proxy blocked since the last call. */
  takeNetworkBlocks?(): { host: string; port: number; reason: string }[];
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
  /**
   * Present when the preview's hunks can be accepted one by one. Before it answers "once", an
   * approver that let the user pick hunks calls this with the accepted ones (0-based). Not called:
   * the whole change.
   */
  selectHunks?: (accepted: readonly number[]) => void;
}

/** Asks the user. The CLI implements it with a prompt. Tests use AutoApprover. */
export interface Approver {
  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalChoice>;
}
