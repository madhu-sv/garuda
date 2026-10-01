import type {
  ModelClient,
  ModelResponse,
  ServerToolSpec,
  ThinkingRequest,
} from "../model/types.js";

export type AgentStopReason =
  | "done"
  | "max_steps"
  | "token_budget"
  | "repeated_calls"
  | "max_tokens"
  | "refusal";

export const DEFAULT_MAX_STEPS = 50;
export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_TOKEN_BUDGET = 20_000_000;

/** Output limit (0.12): cut-off responses that one run recovers from before it stops. */
export const MAX_OUTPUT_RECOVERIES = 3;
/** Output limit (0.12): the max_tokens after a cut-off response (at least). */
export const RECOVERY_MAX_TOKENS = 32_000;

/** Thinking counts toward max_tokens (0.9): more room when /thinking asks for it. */
export function thinkingMaxTokens(
  maxTokens: number,
  thinking: ThinkingRequest | undefined,
): number {
  if (thinking === undefined) return maxTokens;
  if (thinking.effort === "xhigh" || thinking.effort === "max") return Math.max(maxTokens, 32_000);
  return Math.max(maxTokens, 16_384);
}

/** The server tools of `deps` that this model client can run. */
export function usableServerTools(
  model: ModelClient,
  specs: readonly ServerToolSpec[] | undefined,
): ServerToolSpec[] {
  return (specs ?? []).filter((spec) => model.serverTools?.includes(spec.type) === true);
}

/**
 * Output limit (0.12): the note that asks the model to go on. The cut-off response keeps only its
 * text: a half tool call cannot run, and thinking alone is no answer.
 */
export function continuationNote(maxTokens: number, droppedCall: boolean): string {
  return `<garuda_note>Your last response hit the output limit (${maxTokens} tokens) and was cut off${droppedCall ? " before its tool call was complete, so the call did not run" : ""}. Go on from where you were. Keep each response smaller: write a large file in parts, and think less before a simple step.</garuda_note>`;
}

export function finalReason(response: ModelResponse): AgentStopReason {
  if (response.stopReason === "max_tokens") return "max_tokens";
  if (response.stopReason === "refusal") return "refusal";
  return "done";
}
