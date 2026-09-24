import { type CompactionResult, compactIfNeeded } from "../context/compact.js";
import type { KnowledgeIndex } from "../knowledge/index.js";
import { costOf, type Price, totalTokens } from "../model/pricing.js";
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
import type { PermissionGate } from "../permissions/types.js";
import type { Executor } from "../sandbox/types.js";
import type { ToolCallMeta } from "../session/records.js";
import {
  addAssistantResponse,
  addToolResults,
  closeOpenToolCalls,
  type Session,
} from "../session/session.js";
import type { ToolContext, ToolHooks, ToolOutcome, ToolRunner } from "../tools/types.js";

/**
 * The agent loop (F5). Rule: the loop gets every dependency as an argument
 * and never imports the CLI. Tests, evals and replay run it with a fake model.
 */

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolUseBlock }
  | { type: "tool_result"; call: ToolUseBlock; outcome: ToolOutcome }
  | { type: "step_end"; step: number; usage: Usage }
  | { type: "compaction"; result: CompactionResult };

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
}

export type AgentStopReason =
  | "done"
  | "max_steps"
  | "token_budget"
  | "repeated_calls"
  | "max_tokens"
  | "refusal";

export interface AgentResult {
  stopReason: AgentStopReason;
  steps: number;
  /** Token use for this run only. The session keeps the running total. */
  usage: Usage;
}

export const DEFAULT_MAX_STEPS = 50;
export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_TOKEN_BUDGET = 20_000_000;
/** F7: this many identical tool calls in a row stop the run. */
export const REPEAT_LIMIT = 3;

export async function runAgent(session: Session, deps: AgentDeps): Promise<AgentResult> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const budget = deps.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const signal = deps.signal ?? new AbortController().signal;
  const emit = deps.onEvent ?? (() => {});
  const price = deps.price;
  const cost = (r: ModelResponse) => (price === undefined ? undefined : costOf(r.usage, price));
  // Compute the tool list once, so every request in the run sends the same bytes (N2).
  const tools = deps.tools.specs();
  const recent: string[] = [];
  let usage = ZERO_USAGE;
  let steps = 0;

  const finish = (stopReason: AgentStopReason): AgentResult => {
    session.journal?.write({ type: "end", stopReason, steps });
    return { stopReason, steps, usage };
  };

  closeOpenToolCalls(session);

  while (steps < maxSteps) {
    signal.throwIfAborted();
    if (totalTokens(session.usage) >= budget) return finish("token_budget");

    if (deps.contextWindow !== undefined) {
      const result = await compactIfNeeded(
        session,
        deps.model,
        { contextWindow: deps.contextWindow, costOf: cost },
        signal,
      );
      if (result !== undefined) emit({ type: "compaction", result });
    }

    steps++;
    const request: ModelRequest = {
      system: deps.system,
      messages: session.messages,
      tools,
      maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    const response = await callModel(deps.model, request, signal, emit);
    usage = addUsage(usage, response.usage);
    addAssistantResponse(session, response, steps, cost(response));
    emit({ type: "step_end", step: steps, usage: response.usage });

    const calls = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (calls.length === 0) return finish(finalReason(response));

    const context: ToolContext = {
      root: session.root,
      signal,
      permissions: deps.permissions,
      files: session.files,
      ...(deps.executor === undefined ? {} : { executor: deps.executor }),
      ...(deps.knowledge === undefined ? {} : { knowledge: deps.knowledge }),
      ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
    };
    const { results, meta } = await runTools(calls, deps, context, emit);
    addToolResults(session, results, meta);

    for (const call of calls) recent.push(signature(call));
    if (repeated(recent)) return finish("repeated_calls");
  }

  return finish("max_steps");
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
 * Run the tool calls of one step (F8). Consecutive read-only calls run in parallel.
 * Other calls (writes, shell, unknown tools) run one at a time, in call order.
 * The results always keep the call order.
 */
async function runTools(
  calls: readonly ToolUseBlock[],
  deps: AgentDeps,
  context: ToolContext,
  emit: (event: AgentEvent) => void,
): Promise<{ results: ToolResultBlock[]; meta: ToolCallMeta[] }> {
  const { tools, executor } = deps;
  const meta: ToolCallMeta[] = [];
  const runOne = async (call: ToolUseBlock): Promise<ToolResultBlock> => {
    emit({ type: "tool_call", call });
    const started = Date.now();
    const outcome = await tools.execute(call, context);
    const item: ToolCallMeta = {
      toolUseId: call.id,
      name: call.name,
      durationMs: Date.now() - started,
    };
    if (executor !== undefined && tools.runsCommands(call.name)) {
      item.executor = executor.name;
      item.isolation = executor.isolation;
    }
    meta.push(item);
    emit({ type: "tool_result", call, outcome });
    return {
      type: "tool_result",
      toolUseId: call.id,
      content: outcome.content,
      isError: outcome.isError,
    };
  };

  const results: ToolResultBlock[] = [];
  for (const batch of batches(calls, (call) => tools.isReadOnly(call.name))) {
    context.signal.throwIfAborted();
    if (batch.parallel) results.push(...(await Promise.all(batch.calls.map(runOne))));
    else for (const call of batch.calls) results.push(await runOne(call));
  }
  const order = new Map(calls.map((call, i) => [call.id, i]));
  meta.sort((a, b) => (order.get(a.toolUseId) ?? 0) - (order.get(b.toolUseId) ?? 0));
  return { results, meta };
}

/** Split calls into runs of parallel-safe calls and single serial calls. */
function batches<T>(
  items: readonly T[],
  isParallel: (item: T) => boolean,
): Array<{ parallel: boolean; calls: T[] }> {
  const out: Array<{ parallel: boolean; calls: T[] }> = [];
  for (const item of items) {
    const parallel = isParallel(item);
    const last = out.at(-1);
    if (parallel && last?.parallel) last.calls.push(item);
    else out.push({ parallel, calls: [item] });
  }
  return out;
}

/** Tool name and input, with object keys sorted, so equal calls give equal text (F7). */
export function signature(call: ToolUseBlock): string {
  return `${call.name} ${stableJson(call.input)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function repeated(recent: readonly string[]): boolean {
  if (recent.length < REPEAT_LIMIT) return false;
  const last = recent.slice(-REPEAT_LIMIT);
  return last.every((s) => s === last[0]);
}

function finalReason(response: ModelResponse): AgentStopReason {
  if (response.stopReason === "max_tokens") return "max_tokens";
  if (response.stopReason === "refusal") return "refusal";
  return "done";
}
