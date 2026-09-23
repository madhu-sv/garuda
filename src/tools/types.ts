import type { z } from "zod";
import type { CallInfo, PermissionGate } from "../permissions/types.js";
import type { Executor } from "../sandbox/types.js";
import type { FileTracker } from "../session/fileTracker.js";

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
}

/**
 * One tool. The Zod schema validates input (F16) and gives the JSON Schema that the model sees.
 * `O` is the structured output. `toText` turns it into the text that goes back to the model.
 */
export interface Tool<I = unknown, O = string> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  /** Read-only tools run without approval (F17) and can run in parallel (F8). */
  readOnly: boolean;
  /**
   * Describe one call before it runs: the target for rules, and the preview for approval (F18).
   * It may throw to reject the call early, for example when an edit cannot apply.
   */
  describe?(input: I, context: ToolContext): Promise<CallInfo>;
  run(input: I, context: ToolContext): Promise<O>;
  toText?(output: O): string;
}

/** What a tool call gives back to the loop. */
export interface ToolOutcome {
  content: string;
  isError: boolean;
}

/** A tool with its generic types erased, as the registry stores it. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape hatch for a heterogeneous registry; not a public input type.
export type AnyTool = Tool<any, any>;
