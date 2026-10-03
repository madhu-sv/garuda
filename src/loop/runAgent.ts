import type { AuditLogger } from "../audit/logger.js";
import { compactIfNeeded } from "../context/compact.js";
import type { KnowledgeIndex } from "../knowledge/index.js";
import { type Price, responseCost, totalTokens } from "../model/pricing.js";
import {
  addUsage,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ServerToolResultBlock,
  type ServerToolSpec,
  type StopReason,
  type ThinkingRequest,
  type ToolUseBlock,
  type Usage,
  ZERO_USAGE,
} from "../model/types.js";
import type { PermissionGate } from "../permissions/types.js";
import type { Executor } from "../sandbox/types.js";
import {
  addAssistantResponse,
  addContinuation,
  addCost,
  addToolResults,
  closeOpenToolCalls,
  type Session,
} from "../session/session.js";
import type {
  DiagnosticsSource,
  FormatSource,
  ToolContext,
  ToolHooks,
  ToolRunner,
} from "../tools/types.js";
import { callModelWithRetry, MODEL_RETRY_DELAYS_MS } from "./callModel.js";
import type { AgentEvent } from "./events.js";
import {
  type AgentStopReason,
  continuationNote,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TOKEN_BUDGET,
  finalReason,
  MAX_OUTPUT_RECOVERIES,
  RECOVERY_MAX_TOKENS,
  thinkingMaxTokens,
  usableServerTools,
} from "./limits.js";
import { repeated, signature } from "./loopDetector.js";
import { runTools } from "./toolRunner.js";

// Re-export for public API and backwards compatibility:
export type { AgentEvent } from "./events.js";
export {
  type AgentStopReason,
  continuationNote,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TOKEN_BUDGET,
  MAX_OUTPUT_RECOVERIES,
  RECOVERY_MAX_TOKENS,
  thinkingMaxTokens,
  usableServerTools,
} from "./limits.js";
export { REPEAT_LIMIT, signature } from "./loopDetector.js";

export interface AgentDeps {
  model: ModelClient;
  tools: ToolRunner;
  system: string;
  /** Every tool call passes this check (F17–F20). Tests use an AutoApprover. */
  permissions: PermissionGate;
  /** Runs bash commands (N8). Without it, bash calls fail. */
  executor?: Executor;
  /** The local code index for the code tools. Without it, those tools fail. */
  knowledge?: KnowledgeIndex;
  /** The user's hooks around tool calls (0.2). */
  hooks?: ToolHooks;
  /** Language server diagnostics after edits (0.4). */
  diagnostics?: DiagnosticsSource;
  /** The project's formatter after edits (0.10). */
  format?: FormatSource;
  /** Structured audit logger (0.17). */
  audit?: AuditLogger;
  maxTokens?: number;
  /** Stop after this many model calls in one run (F6). */
  maxSteps?: number;
  /** Stop when the session has used this many tokens in total (F6). */
  tokenBudget?: number;
  /** Context window of the model. Compaction starts at 80% of it (F23). */
  contextWindow?: number;
  /** Model price. Without it, cost stays unknown. */
  price?: Price;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /** Waits before each retry of a broken model stream. Default: 1 s, then 4 s. */
  retryDelaysMs?: readonly number[];
  /** Tools that the provider runs (0.6: Claude's web search). */
  serverTools?: readonly ServerToolSpec[];
  /** Keep Claude's thinking blocks in the conversation (0.9, default true). */
  keepThinking?: boolean;
  /** What each request asks of Claude's thinking (0.9, /thinking). */
  thinking?: ThinkingRequest;
  /**
   * Write the "end" record when the run stops (default true). A subagent run writes its own
   * single end record after its wrap-up call (0.14.1, review: there were two).
   */
  endRecord?: boolean;
}

export interface AgentResult {
  stopReason: AgentStopReason;
  steps: number;
  /** Token use for this run only. The session keeps the running total. */
  usage: Usage;
  /** Time spent in model calls in this run, retries included (0.5). */
  apiMs: number;
  /** The stop reason of the last model response (0.5). */
  modelStopReason?: StopReason;
}

/**
 * The agent loop (F5). Rule: the loop receives all dependencies as arguments
 * and never imports the CLI. Tests, evals and replay run it with a fake model.
 */
export async function runAgent(session: Session, deps: AgentDeps): Promise<AgentResult> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const budget = deps.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const signal = deps.signal ?? new AbortController().signal;
  const emit = deps.onEvent ?? (() => {});
  const price = deps.price;
  const cost = (r: ModelResponse) => (price === undefined ? undefined : responseCost(r, price));
  // Compute the tool list once, so every request in the run sends the same bytes (N2).
  const serverTools = usableServerTools(deps.model, deps.serverTools);
  // A server tool replaces a client tool of the same name (0.6: Claude's web_search over Tavily's).
  const tools = deps.tools.specs().filter((t) => !serverTools.some((s) => s.type === t.name));
  const recent: string[] = [];
  let usage = ZERO_USAGE;
  let steps = 0;
  let apiMs = 0;
  let modelStopReason: StopReason | undefined;
  let outputLimit = thinkingMaxTokens(deps.maxTokens ?? DEFAULT_MAX_TOKENS, deps.thinking);
  let recoveries = 0;

  const finish = (stopReason: AgentStopReason): AgentResult => {
    if (deps.endRecord !== false) session.journal?.write({ type: "end", stopReason, steps });
    return {
      stopReason,
      steps,
      usage,
      apiMs,
      ...(modelStopReason === undefined ? {} : { modelStopReason }),
    };
  };

  closeOpenToolCalls(session);

  while (steps < maxSteps) {
    signal.throwIfAborted();
    if (totalTokens(session.usage) >= budget) return finish("token_budget");

    if (deps.contextWindow !== undefined) {
      const result = await compactIfNeeded(
        session,
        deps.model,
        {
          contextWindow: deps.contextWindow,
          costOf: cost,
          ...(deps.retryDelaysMs === undefined ? {} : { retryDelaysMs: deps.retryDelaysMs }),
        },
        signal,
      );
      if (result !== undefined) emit({ type: "compaction", result });
    }

    steps++;
    const request: ModelRequest = {
      system: deps.system,
      messages: session.messages,
      tools,
      ...(serverTools.length === 0 ? {} : { serverTools }),
      maxTokens: outputLimit,
      ...(deps.thinking === undefined ? {} : { thinking: deps.thinking }),
    };
    const started = performance.now();
    const received = await callModelWithRetry(
      deps.model,
      request,
      signal,
      emit,
      deps.retryDelaysMs ?? MODEL_RETRY_DELAYS_MS,
    ).finally(() => {
      apiMs += performance.now() - started;
    });
    const kept =
      deps.keepThinking === false
        ? { ...received, content: received.content.filter((b) => b.type !== "thinking") }
        : received;
    // Output limit (0.12): a cut-off response keeps its text only; the model is asked to go on
    // with more room.
    const cutOff = kept.stopReason === "max_tokens" && recoveries < MAX_OUTPUT_RECOVERIES;
    const response = cutOff
      ? {
          ...kept,
          content: kept.content.filter((b) => b.type === "text" && b.text.trim() !== ""),
        }
      : kept;
    modelStopReason = response.stopReason;
    usage = addUsage(usage, response.usage);
    addAssistantResponse(session, response, steps, cost(response));
    emit({ type: "step_end", step: steps, usage: response.usage, response });
    for (const call of response.content) {
      if (call.type !== "server_tool_use") continue;
      const result = response.content.find(
        (b): b is ServerToolResultBlock =>
          b.type === "server_tool_result" && b.toolUseId === call.id,
      );
      emit({ type: "server_tool", call, ...(result === undefined ? {} : { result }) });
    }

    if (cutOff) {
      recoveries++;
      const limit = outputLimit;
      outputLimit = Math.max(outputLimit, RECOVERY_MAX_TOKENS);
      const dropped = kept.content.some((b) => b.type === "tool_use");
      addContinuation(session, continuationNote(limit, dropped), outputLimit);
      emit({
        type: "notice",
        text: `The response hit the output limit (${limit} tokens); Garuda asks the model to go on with ${outputLimit}.`,
      });
      continue;
    }

    const calls = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (calls.length === 0 && response.stopReason === "pause_turn") continue;
    if (calls.length === 0) return finish(finalReason(response));

    const context: ToolContext = {
      root: session.root,
      signal,
      permissions: deps.permissions,
      files: session.files,
      ...(deps.executor === undefined ? {} : { executor: deps.executor }),
      ...(deps.knowledge === undefined ? {} : { knowledge: deps.knowledge }),
      ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
      ...(deps.diagnostics === undefined ? {} : { diagnostics: deps.diagnostics }),
      ...(deps.format === undefined ? {} : { format: deps.format }),
      ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    };
    const { results, meta } = await runTools(calls, deps, context, emit);
    addToolResults(session, results, meta);
    for (const { subagent } of meta) {
      if (subagent === undefined) continue;
      addCost(session, subagent.usage, subagent.costUsd);
      usage = addUsage(usage, subagent.usage);
    }

    for (const call of calls) recent.push(signature(call));
    if (repeated(recent)) return finish("repeated_calls");
  }

  return finish("max_steps");
}
