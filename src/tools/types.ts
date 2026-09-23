import type { z } from "zod";

export interface ToolContext {
  /** Absolute path of the working root (F1, F15). */
  root: string;
  signal: AbortSignal;
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
