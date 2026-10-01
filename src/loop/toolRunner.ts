import type { ToolResultBlock, ToolUseBlock } from "../model/types.js";
import type { Executor } from "../sandbox/types.js";
import type { ToolCallMeta } from "../session/records.js";
import type { ToolContext, ToolRunner } from "../tools/types.js";
import type { AgentEvent } from "./events.js";

export interface ToolRunnerDeps {
  tools: ToolRunner;
  executor?: Executor;
}

/**
 * Run the tool calls of one step (F8). Consecutive read-only calls run in parallel.
 * Other calls (writes, shell, unknown tools) run one at a time, in call order.
 * The results always keep the call order.
 */
export async function runTools(
  calls: readonly ToolUseBlock[],
  deps: ToolRunnerDeps,
  context: ToolContext,
  emit: (event: AgentEvent) => void,
): Promise<{ results: ToolResultBlock[]; meta: ToolCallMeta[] }> {
  const { tools, executor } = deps;
  const meta: ToolCallMeta[] = [];
  const runOne = async (call: ToolUseBlock): Promise<ToolResultBlock> => {
    emit({ type: "tool_call", call });
    const started = Date.now();
    const outcome = await tools.execute(call, {
      ...context,
      callId: call.id,
      progress: (text) => emit({ type: "tool_progress", call, text }),
    });
    const item: ToolCallMeta = {
      toolUseId: call.id,
      name: call.name,
      durationMs: Date.now() - started,
      ...(outcome.subagent === undefined ? {} : { subagent: outcome.subagent }),
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
export function batches<T>(
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
