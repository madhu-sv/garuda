import {
  addUsage,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ToolResultBlock,
  type ToolUseBlock,
  type Usage,
  ZERO_USAGE,
} from "../model/types.js";
import type { Session } from "../session/session.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolOutcome } from "../tools/types.js";

/**
 * The agent loop (F5). Rule: the loop gets every dependency as an argument
 * and never imports the CLI. Tests and evals run it with a fake model.
 */

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolUseBlock }
  | { type: "tool_result"; call: ToolUseBlock; outcome: ToolOutcome }
  | { type: "step_end"; step: number; usage: Usage };

export interface AgentDeps {
  model: ModelClient;
  tools: ToolRegistry;
  system: string;
  maxTokens?: number;
  /** Hard stop. M4 adds the token budget and the user message (F6). */
  maxSteps?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export type AgentStopReason = "done" | "max_steps" | "max_tokens" | "refusal";

export interface AgentResult {
  stopReason: AgentStopReason;
  steps: number;
  /** Token use for this run only. The session keeps the running total. */
  usage: Usage;
}

export const DEFAULT_MAX_STEPS = 50;
export const DEFAULT_MAX_TOKENS = 8192;

export async function runAgent(session: Session, deps: AgentDeps): Promise<AgentResult> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const signal = deps.signal ?? new AbortController().signal;
  const emit = deps.onEvent ?? (() => {});
  // Compute the tool list once, so every request in the run sends the same bytes (N2).
  const tools = deps.tools.specs();
  let usage = ZERO_USAGE;

  for (let step = 1; step <= maxSteps; step++) {
    signal.throwIfAborted();

    const request: ModelRequest = {
      system: deps.system,
      messages: session.messages,
      tools,
      maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    const response = await callModel(deps.model, request, signal, emit);

    usage = addUsage(usage, response.usage);
    session.usage = addUsage(session.usage, response.usage);
    if (response.content.length > 0) {
      session.messages.push({ role: "assistant", content: response.content });
    }
    emit({ type: "step_end", step, usage: response.usage });

    const calls = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (calls.length === 0) {
      return { stopReason: finalReason(response), steps: step, usage };
    }

    const results = await runTools(calls, deps.tools, session.root, signal, emit);
    session.messages.push({ role: "user", content: results });
  }

  return { stopReason: "max_steps", steps: maxSteps, usage };
}

async function callModel(
  model: ModelClient,
  request: ModelRequest,
  signal: AbortSignal,
  emit: (event: AgentEvent) => void,
): Promise<ModelResponse> {
  let response: ModelResponse | undefined;
  for await (const event of model.stream(request, { signal })) {
    if (event.type === "text_delta") emit(event);
    else response = event.response;
  }
  if (response === undefined) throw new Error("Model stream ended without a response.");
  return response;
}

/**
 * Run the tool calls of one step, in order.
 * M2 runs read-only calls in parallel (F8). Results keep the call order in all cases.
 */
async function runTools(
  calls: readonly ToolUseBlock[],
  tools: ToolRegistry,
  root: string,
  signal: AbortSignal,
  emit: (event: AgentEvent) => void,
): Promise<ToolResultBlock[]> {
  const results: ToolResultBlock[] = [];
  for (const call of calls) {
    signal.throwIfAborted();
    emit({ type: "tool_call", call });
    const outcome = await tools.execute(call, { root, signal });
    emit({ type: "tool_result", call, outcome });
    results.push({
      type: "tool_result",
      toolUseId: call.id,
      content: outcome.content,
      isError: outcome.isError,
    });
  }
  return results;
}

function finalReason(response: ModelResponse): AgentStopReason {
  if (response.stopReason === "max_tokens") return "max_tokens";
  if (response.stopReason === "refusal") return "refusal";
  return "done";
}
