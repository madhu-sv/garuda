import type { CompactionResult } from "../context/compact.js";
import type {
  ModelResponse,
  ServerToolResultBlock,
  ServerToolUseBlock,
  ToolUseBlock,
  Usage,
} from "../model/types.js";
import type { ToolOutcome } from "../tools/types.js";

export type AgentEvent =
  | { type: "text_delta"; text: string }
  /** Claude's readable thinking as it streams (0.9, /thinking show). */
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; call: ToolUseBlock }
  | { type: "tool_result"; call: ToolUseBlock; outcome: ToolOutcome }
  /** A one-line status of a long call, for example a subagent's current step. */
  | { type: "tool_progress"; call: ToolUseBlock; text: string }
  /** The model stream broke; the loop sends the same request again. Text shown so far is void. */
  | { type: "model_retry"; attempt: number; maxRetries: number; delayMs: number; reason: string }
  /** A model response is in the session. `response` has all its blocks (JSON output, 0.5). */
  | { type: "step_end"; step: number; usage: Usage; response: ModelResponse }
  | { type: "compaction"; result: CompactionResult }
  /** A line for the user from the runtime, not the model (0.6: attached @files). */
  | { type: "notice"; text: string }
  /**
   * A tool call that the provider ran (0.6: Claude's web search), with its result when the
   * response has it (a search deferred by `tool_use` has none yet).
   */
  | { type: "server_tool"; call: ServerToolUseBlock; result?: ServerToolResultBlock };
