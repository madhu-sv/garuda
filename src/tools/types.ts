import type { z } from "zod";
import type { KnowledgeIndex } from "../knowledge/index.js";
import type { ToolSpec, ToolUseBlock } from "../model/types.js";
import type { CallInfo, PermissionGate } from "../permissions/types.js";
import type { Executor } from "../sandbox/types.js";
import type { FileTracker } from "../session/fileTracker.js";
import type { SubagentReport } from "../session/records.js";

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
  /** Set by subagent tools: the loop adds the child's usage to the session. */
  subagent?: SubagentReport;
}

/** A tool with its generic types erased, as the registry stores it. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape hatch for a heterogeneous registry; not a public input type.
export type AnyTool = Tool<any, any>;
