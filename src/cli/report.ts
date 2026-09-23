import type { AgentResult, AgentStopReason } from "../loop/runAgent.js";
import { totalTokens } from "../model/pricing.js";
import type { Session } from "../session/session.js";

/** Short token counts: 950, 12.3k, 4.5M. */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatUsd(usd: number | undefined): string {
  if (usd === undefined) return "cost unknown";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** The line that Garuda prints after each turn (F22). */
export function usageLine(
  result: AgentResult,
  session: Session,
  runCostUsd: number | undefined,
  contextWindow: number,
): string {
  const u = result.usage;
  const input = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const percent = Math.round((session.contextTokens / contextWindow) * 100);
  return [
    `${result.stopReason} · ${result.steps} step(s)`,
    `${formatTokens(input)} in (${formatTokens(u.cacheReadTokens)} cached) / ${formatTokens(u.outputTokens)} out`,
    formatUsd(runCostUsd),
    `context ${percent}% of ${formatTokens(contextWindow)}`,
    `session ${formatTokens(totalTokens(session.usage))} tokens, ${formatUsd(session.costUsd)}`,
  ].join(" · ");
}

/** Why the run stopped, in words, and what the user can do (F6, F7). */
export function stopMessage(
  reason: AgentStopReason,
  limits: { maxSteps: number; tokenBudget: number },
): string | undefined {
  switch (reason) {
    case "done":
      return undefined;
    case "max_steps":
      return `Stopped: the run reached the step limit (${limits.maxSteps}). Use --resume to continue, or raise limits.maxSteps in .garuda/settings.json.`;
    case "token_budget":
      return `Stopped: the session used its token budget (${formatTokens(limits.tokenBudget)} tokens). Raise limits.tokenBudget in .garuda/settings.json to continue.`;
    case "repeated_calls":
      return "Stopped: the agent made the same tool call 3 times in a row, so it may be stuck. Use --resume with a hint to continue.";
    case "max_tokens":
      return "Stopped: the response reached the output token limit.";
    case "refusal":
      return "Stopped: the model refused the request.";
  }
}
