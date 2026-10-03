import type { z } from "zod";
import type { AuditLogger } from "../audit/logger.js";
import type { KnowledgeIndex } from "../knowledge/index.js";
import type { ToolSpec, ToolUseBlock } from "../model/types.js";
import type { CallInfo, PermissionGate } from "../permissions/types.js";
import type { Executor } from "../sandbox/types.js";
import type { FileTracker } from "../session/fileTracker.js";
import type { SubagentReport } from "../session/records.js";
import { unifiedDiff } from "./diff.js";

export interface ToolContext {
  /** Absolute path of the working root (F1, F15). */
  root: string;
  signal: AbortSignal;
  /** The permission check (F17–F20). The registry calls it before `run`. */
  permissions: PermissionGate;
  /** What the agent has read in this session (F11). */
  files: FileTracker;
  /** Runs commands (N8). Absent when the host gives no executor: bash then fails. */
  executor?: Executor;
  /** The local code index, for find_symbol, find_references and repo_map. */
  knowledge?: KnowledgeIndex;
  /** The user's hooks (0.2). The registry calls them around each tool call. */
  hooks?: ToolHooks;
  /** The id of the current call (the loop sets it per call). */
  callId?: string;
  /** A one-line status while a long call runs, for the live view (the loop sets it per call). */
  progress?: (text: string) => void;
  /** Language server errors for a file that a tool just wrote (0.4). Absent when LSP is off. */
  diagnostics?: DiagnosticsSource;
  /** Formats a file that a tool just wrote (0.10). Absent when formatters are off. */
  format?: FormatSource;
  /** The user accepted only these hunks of the preview (U0); the registry sets it per call. */
  approvedHunks?: readonly number[];
  /** The preview that the user reviewed with `approvedHunks`, to check the change is the same. */
  approvedPreview?: string;
  /** Structured audit logger (0.17). Absent when audit is off. */
  audit?: AuditLogger;
}

/**
 * Runs the project's formatter on a file (0.10). Undefined: no formatter for this file. It never
 * throws: a broken formatter must not fail an edit that was already written.
 */
export type FormatSource = (
  absolute: string,
  signal: AbortSignal,
) => Promise<{ name: string; text?: string; problem?: string } | undefined>;

/** Most lines of the formatter's diff in a tool result (0.10). */
const FORMAT_DIFF_LINES = 30;

/**
 * After edit_file or write_file: format the file (0.10), then add diagnostics (0.4). The model
 * gets what the formatter changed, and the file counts as read in its new form.
 */
export async function afterWrite(
  result: string,
  context: ToolContext,
  file: { absolute: string; shown: string; text: string },
): Promise<string> {
  let text = file.text;
  let note = "";
  if (context.format !== undefined) {
    const formatted = await context.format(file.absolute, context.signal).catch(() => undefined);
    if (formatted?.problem !== undefined) {
      note = `\n${formatted.name} could not format it: ${formatted.problem}`;
    } else if (formatted?.text !== undefined && formatted.text !== text) {
      const diff = unifiedDiff(file.shown, text, formatted.text).split("\n");
      text = formatted.text;
      context.files.record(file.absolute, text);
      note =
        diff.length <= FORMAT_DIFF_LINES
          ? `\nFormatted with ${formatted.name}:\n${diff.join("\n")}`
          : `\nFormatted with ${formatted.name} (${diff.length} diff lines): read the file again before you edit the changed lines.`;
    }
  }
  return withDiagnostics(`${result}${note}`, context, { ...file, text });
}

/**
 * Gives the text to add after an edit result, or undefined (no server, a timeout). It never
 * throws: a broken server must not fail an edit that was already written.
 */
export type DiagnosticsSource = (
  absolute: string,
  shown: string,
  text: string,
  signal: AbortSignal,
) => Promise<string | undefined>;

/** Add the diagnostics text, if any, after a tool's own result. */
export async function withDiagnostics(
  result: string,
  context: ToolContext,
  file: { absolute: string; shown: string; text: string },
): Promise<string> {
  if (context.diagnostics === undefined) return result;
  let note: string | undefined;
  try {
    note = await context.diagnostics(file.absolute, file.shown, file.text, context.signal);
  } catch {
    note = undefined;
  }
  return note === undefined ? result : `${result}\n\n${note}`;
}

/** Hooks around tool calls. They can block a call or add feedback; they never approve one. */
export interface ToolHooks {
  /** Before the permission check. A string blocks the call and says why. */
  before(call: HookCall, signal: AbortSignal): Promise<string | undefined>;
  /** After the call. It may add feedback to the result. */
  after(call: HookCall, outcome: ToolOutcome, signal: AbortSignal): Promise<ToolOutcome>;
}

export interface HookCall {
  tool: string;
  input: unknown;
  info?: CallInfo;
}

/**
 * One tool. The Zod schema validates input (F16) and gives the JSON Schema that the model sees.
 * `O` is the structured output. `toText` turns it into the text that goes back to the model.
 */
export interface Tool<I = unknown, O = string> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  /** The JSON Schema the model sees, when it does not come from `inputSchema` (MCP tools). */
  jsonSchema?: Record<string, unknown>;
  /** Read-only tools run without approval (F17) and can run in parallel (F8). */
  readOnly: boolean;
  /**
   * A read-only tool whose calls must not run in parallel (0.5): the agent tool, when an agent may
   * write files. The permission check still treats it as read-only; its child calls are checked.
   */
  runsAlone?: boolean;
  /** True for tools that run commands through the Executor. The session log records the executor (N8). */
  runsCommands?: boolean;
  /**
   * Describe one call before it runs: the target for rules, and the preview for approval (F18).
   * It may throw to reject the call early, for example when an edit cannot apply.
   */
  describe?(input: I, context: ToolContext): Promise<CallInfo>;
  run(input: I, context: ToolContext): Promise<O>;
  toText?(output: O): string;
  /** True when the output is an error result (MCP tools report errors this way). */
  isError?(output: O): boolean;
  /** For a subagent tool: the usage of the child run, for the session totals. */
  report?(output: O): SubagentReport | undefined;
}

/** What the loop needs from a tool set. ToolRegistry implements it; replay uses a recorded one. */
export interface ToolRunner {
  specs(): ToolSpec[];
  isReadOnly(name: string): boolean;
  runsCommands(name: string): boolean;
  execute(call: ToolUseBlock, context: ToolContext): Promise<ToolOutcome>;
}

/** What a tool call gives back to the loop. */
export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** The permission check refused the call (for `permission_denials` in JSON output, 0.5). */
  denied?: boolean;
  /** Set by subagent tools: the loop adds the child's usage to the session. */
  subagent?: SubagentReport;
}

/** A tool with its generic types erased, as the registry stores it. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape hatch for a heterogeneous registry; not a public input type.
export type AnyTool = Tool<any, any>;

/**
 * A subagent run that failed after it used the model (0.14.1, review). The registry still adds the
 * report to the outcome, so the tokens and the cost of the failed run count for the session.
 */
export class SubagentFailure extends Error {
  override readonly name = "SubagentFailure";
  constructor(
    message: string,
    readonly report: SubagentReport,
  ) {
    super(message);
  }
}
