import type { KnowledgeIndex } from "../knowledge/index.js";
import {
  type AgentEvent,
  type AgentStopReason,
  runAgent,
  usableServerTools,
} from "../loop/runAgent.js";
import { type Price, responseCost } from "../model/pricing.js";
import { serverCallText } from "../model/serverTools.js";
import {
  addUsage,
  type ModelClient,
  type ModelResponse,
  type ServerToolSpec,
  type TextBlock,
  type ToolUseBlock,
  type Usage,
} from "../model/types.js";
import type { PermissionGate } from "../permissions/types.js";
import type { Executor } from "../sandbox/types.js";
import type { SubagentReport } from "../session/records.js";
import { addAssistantResponse, addUserMessage, createSession } from "../session/session.js";
import type { Journal } from "../session/store.js";
import type { ToolContext, ToolHooks, ToolRunner } from "../tools/types.js";
import { VERSION } from "../version.js";

/**
 * One child run (0.3, shared since 0.5 by explore and custom agents): a new session with its own
 * system prompt and tools, through the same permission engine, hooks and executor as the main
 * agent. It returns the child's last text, a line per tool call and a usage report. When the run
 * stops at a limit, one more call with no tools asks for the answer.
 */

export interface ChildModel {
  /** The model spec, for the session file and the report. */
  spec: string;
  client: () => Promise<ModelClient>;
  contextWindow: number;
  price?: Price;
}

export interface ChildLimits {
  /** Model calls per run. */
  maxSteps: number;
  /** Tokens per run (input, output and cache). */
  tokenBudget: number;
}

export interface ChildRun {
  /** Child session id, for example explore-x1 or agent-reviewer-x2. */
  id: string;
  system: string;
  prompt: string;
  tools: ToolRunner;
  model: ChildModel;
  permissions: PermissionGate;
  limits: ChildLimits;
  maxTokens: number;
  knowledge?: KnowledgeIndex;
  hooks?: ToolHooks;
  /** Runs bash for the child (custom agents with bash). */
  executor?: Executor;
  journal?: Journal;
  /** Executor name and isolation, for the child's start record. */
  executorInfo?: { name: string; isolation: string };
  /** Tools the provider runs (0.6: Claude's web search), when the child's model can. */
  serverTools?: readonly ServerToolSpec[];
}

export interface ChildResult {
  answer: string;
  /** One short line per tool call of the child, in order. */
  calls: string[];
  report: SubagentReport;
}

const WRAP_UP =
  "You reached the limit of this run. Do not call tools. Answer now with what you found and did, and say what is still open.";

export async function runChild(run: ChildRun, context: ToolContext): Promise<ChildResult> {
  const { journal, limits } = run;
  const session = createSession(context.root, run.id, journal);
  journal?.write({
    type: "start",
    sessionId: run.id,
    root: context.root,
    version: VERSION,
    model: run.model.spec,
    executor: run.executorInfo?.name ?? "none",
    isolation: run.executorInfo?.isolation ?? "none",
    limits: { ...limits, contextWindow: run.model.contextWindow },
  });
  addUserMessage(session, run.prompt);

  const model = await run.model.client();
  const calls: string[] = [];
  const onEvent = (event: AgentEvent) => {
    if (event.type !== "tool_call" && event.type !== "server_tool") return;
    const line =
      event.type === "tool_call"
        ? describeCall(event.call)
        : `${event.call.name} (Claude) ${serverCallText(event.call)}`;
    calls.push(line);
    context.progress?.(`step ${calls.length} · ${line}`);
  };
  const result = await runAgent(session, {
    model,
    tools: run.tools,
    system: run.system,
    permissions: run.permissions,
    ...(run.knowledge === undefined ? {} : { knowledge: run.knowledge }),
    ...(run.hooks === undefined ? {} : { hooks: run.hooks }),
    ...(run.executor === undefined ? {} : { executor: run.executor }),
    ...(run.serverTools === undefined ? {} : { serverTools: run.serverTools }),
    maxSteps: limits.maxSteps,
    tokenBudget: limits.tokenBudget,
    maxTokens: run.maxTokens,
    contextWindow: run.model.contextWindow,
    ...(run.model.price === undefined ? {} : { price: run.model.price }),
    signal: context.signal,
    onEvent,
  });

  let usage: Usage = result.usage;
  let steps = result.steps;
  let answer = lastText(session.messages);
  if (stoppedEarly(result.stopReason)) {
    // One more call with no tool use, so the run still gives an answer.
    context.progress?.("writing the answer");
    addUserMessage(session, WRAP_UP);
    const response = await callOnce(model, run, session.messages, context.signal);
    steps++;
    usage = addUsage(usage, response.usage);
    const price = run.model.price;
    addAssistantResponse(
      session,
      response,
      steps,
      price === undefined ? undefined : responseCost(response, price),
    );
    answer = textOf(response.content) || answer;
    journal?.write({ type: "end", stopReason: "wrap_up", steps });
  }

  // The session adds each response at its own price (the Batch API costs half).
  const costUsd = run.model.price === undefined ? undefined : session.costUsd;
  return {
    answer: answer.trim(),
    calls,
    report: {
      sessionId: run.id,
      model: run.model.spec,
      steps,
      stopReason: result.stopReason,
      usage,
      ...(costUsd === undefined ? {} : { costUsd }),
    },
  };
}

export function stoppedEarly(reason: AgentStopReason): boolean {
  return reason === "max_steps" || reason === "token_budget" || reason === "repeated_calls";
}

/** The text of the last assistant message that has text. */
function lastText(messages: readonly { role: string; content: readonly { type: string }[] }[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const text = textOf(message.content);
    if (text !== "") return text;
  }
  return "";
}

function textOf(content: readonly { type: string }[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** One model call; tool calls in the response are ignored. */
async function callOnce(
  model: ModelClient,
  run: ChildRun,
  messages: Parameters<ModelClient["stream"]>[0]["messages"],
  signal: AbortSignal,
): Promise<ModelResponse> {
  let response: ModelResponse | undefined;
  // The same tool list as before: the API needs it when the history holds tool calls (N2 too).
  const serverTools = usableServerTools(model, run.serverTools);
  for await (const event of model.stream(
    {
      system: run.system,
      messages,
      tools: run.tools.specs().filter((t) => !serverTools.some((s) => s.type === t.name)),
      ...(serverTools.length === 0 ? {} : { serverTools }),
      maxTokens: run.maxTokens,
    },
    { signal },
  )) {
    if (event.type === "response") response = event.response;
  }
  if (response === undefined) throw new Error("Model stream ended without a response.");
  return response;
}

/** A short line for one child call: `grep /Coupon/ in src`. */
export function describeCall(call: ToolUseBlock): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const cut = (text: string) => (text.length <= 80 ? text : `${text.slice(0, 79)}…`);
  switch (call.name) {
    case "read_file":
      return `read_file ${cut(str("path"))}`;
    case "glob":
      return `glob ${cut(str("pattern"))}`;
    case "grep":
      return `grep /${cut(str("pattern"))}/${str("path") ? ` in ${cut(str("path"))}` : ""}`;
    case "bash":
      return `bash ${cut(str("command"))}`;
    case "edit_file":
    case "write_file":
      return `${call.name} ${cut(str("path"))}`;
    default:
      return `${call.name} ${cut(JSON.stringify(call.input))}`;
  }
}
