import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentStopReason } from "../loop/runAgent.js";
import type { McpState } from "../mcp/manager.js";
import type { ModelResponse, Usage } from "../model/types.js";
import { VERSION } from "../version.js";
import type { Renderer } from "./renderer.js";
import type { TurnOutcome } from "./turn.js";

/**
 * `-p --output-format json|stream-json` (0.5). The lines use the field names of Claude Code's
 * headless mode (`claude -p --output-format …`), so scripts written for it also read Garuda:
 *
 *   json         one line at the end: the `result` message.
 *   stream-json  one JSON object per line: `system/init`, then `assistant` (a model response with
 *                all its blocks) and `user` (one tool result) per step, `system/api_retry` and
 *                `system/compact_boundary` when they happen, and the `result` message last.
 *
 * stdout holds only JSON. Warnings and errors go to stderr; `--verbose` adds the tool activity.
 */

export type OutputFormat = "text" | "json" | "stream-json";
export const OUTPUT_FORMATS: readonly OutputFormat[] = ["text", "json", "stream-json"];

/** What the `system/init` line reports. Read when the first line is written. */
export interface RunInfo {
  cwd: string;
  model: string;
  tools: string[];
  mcpServers: { name: string; state: McpState }[];
  permissionMode: "default" | "plan";
  slashCommands: string[];
  /** Skill names (0.5). */
  skills?: string[];
  /** Custom agent names (0.5). */
  agents?: string[];
  apiKeySource: "ANTHROPIC_API_KEY" | "none";
}

/** The rest of the `result` line, known when the turn ends. */
export interface ResultInfo {
  /** The session total, as Claude Code reports a resumed session. 0 when the price is unknown. */
  totalCostUsd: number;
  /** This run's cost, for `modelUsage`. */
  runCostUsd: number | undefined;
  contextWindow: number;
  maxOutputTokens: number;
  /** The stop message for an early stop (errors[]). */
  stopMessage?: string | undefined;
}

export interface PermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: unknown;
}

type Line = Record<string, unknown>;

export interface JsonOutputOptions {
  format: "json" | "stream-json";
  /** Writes one line to stdout. */
  write: (line: string) => void;
  /** stderr: warnings and errors always; tool activity and notes with `verbose`. */
  log: Renderer;
  verbose: boolean;
  sessionId: () => string;
  runInfo: () => RunInfo;
  now?: () => number;
}

export class JsonOutput implements Renderer {
  private readonly started: number;
  private initDone = false;
  private lastText = "";
  private readonly denials: PermissionDenial[] = [];

  constructor(private readonly options: JsonOutputOptions) {
    this.started = this.now();
  }

  event(event: AgentEvent): void {
    if (this.options.verbose) this.options.log.event(event);
    switch (event.type) {
      case "step_end":
        this.lastText = textOf(event.response);
        this.stream(() => assistantLine(event.response, this.run().model));
        return;
      case "tool_result":
        if (event.outcome.denied === true) {
          this.denials.push({
            tool_name: event.call.name,
            tool_use_id: event.call.id,
            tool_input: event.call.input,
          });
        }
        this.stream(() => ({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: event.call.id,
                content: event.outcome.content,
                is_error: event.outcome.isError,
              },
            ],
          },
          parent_tool_use_id: null,
        }));
        return;
      case "model_retry":
        this.stream(() => ({
          type: "system",
          subtype: "api_retry",
          attempt: event.attempt,
          max_retries: event.maxRetries,
          retry_delay_ms: event.delayMs,
          error_status: null,
          error: "unknown",
          message: event.reason,
        }));
        return;
      case "compaction":
        this.stream(() => ({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: {
            trigger: "auto",
            pre_tokens: event.result.beforeTokens,
            post_tokens: event.result.afterTokens,
          },
        }));
        return;
      default:
        return;
    }
  }

  info(text: string): void {
    if (this.options.verbose) this.options.log.info(text);
  }

  warn(text: string): void {
    this.options.log.warn(text);
  }

  error(text: string): void {
    this.options.log.error(text);
  }

  /** Write the `result` line (and `system/init` first, if no line came yet). */
  finish(outcome: TurnOutcome, info: ResultInfo): void {
    const line = resultLine(outcome, {
      ...info,
      model: this.run().model,
      durationMs: Math.round(this.now() - this.started),
      lastText: this.lastText,
      denials: this.denials,
    });
    if (this.options.format === "stream-json") this.stream(() => line);
    else this.writeLine(line);
  }

  private stream(make: () => Line): void {
    if (this.options.format !== "stream-json") return;
    if (!this.initDone) {
      this.initDone = true;
      this.writeLine(initLine(this.run()));
    }
    this.writeLine(make());
  }

  private writeLine(line: Line): void {
    this.options.write(
      JSON.stringify({ ...line, session_id: this.options.sessionId(), uuid: randomUUID() }),
    );
  }

  private run(): RunInfo {
    return this.options.runInfo();
  }

  private now(): number {
    return (this.options.now ?? performance.now.bind(performance))();
  }
}

export function initLine(info: RunInfo): Line {
  return {
    type: "system",
    subtype: "init",
    cwd: info.cwd,
    tools: info.tools,
    mcp_servers: info.mcpServers.map((s) => ({ name: s.name, status: mcpStatus(s.state) })),
    model: info.model,
    permissionMode: info.permissionMode,
    slash_commands: info.slashCommands,
    apiKeySource: info.apiKeySource,
    output_style: "default",
    skills: info.skills ?? [],
    agents: info.agents ?? [],
    plugins: [],
    garuda_version: VERSION,
  };
}

/** Claude Code's server states: connected, failed, needs-auth, pending, disabled. */
function mcpStatus(state: McpState): string {
  if (state === "connected" || state === "failed") return state;
  return state === "stopped" ? "failed" : "disabled";
}

export function assistantLine(response: ModelResponse, model: string): Line {
  return {
    type: "assistant",
    message: {
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      role: "assistant",
      model,
      content: response.content.map((block) => {
        switch (block.type) {
          case "text":
            return block.citations === undefined
              ? { type: "text", text: block.text }
              : { type: "text", text: block.text, citations: block.citations };
          case "tool_use":
            return { type: "tool_use", id: block.id, name: block.name, input: block.input };
          // Server tool blocks (0.6) as the API gave them, as Claude Code shows them.
          default:
            return block.wire;
        }
      }),
      stop_reason: response.stopReason,
      stop_sequence: null,
      usage: apiUsage(response.usage),
    },
    parent_tool_use_id: null,
  };
}

function apiUsage(u: Usage): Line {
  return {
    input_tokens: u.inputTokens,
    cache_creation_input_tokens: u.cacheWriteTokens,
    cache_read_input_tokens: u.cacheReadTokens,
    output_tokens: u.outputTokens,
    ...(u.webSearches === undefined
      ? {}
      : { server_tool_use: { web_search_requests: u.webSearches, web_fetch_requests: 0 } }),
  };
}

function textOf(response: ModelResponse): string {
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}

type Subtype = "success" | "error_max_turns" | "error_during_execution";

/** Garuda's stop reasons as Claude Code result subtypes and terminal reasons. */
const STOPS: Record<AgentStopReason, { subtype: Subtype; terminal?: string }> = {
  done: { subtype: "success", terminal: "completed" },
  // The model stopped by itself; Claude Code reports these as success with the stop_reason.
  max_tokens: { subtype: "success", terminal: "completed" },
  refusal: { subtype: "success", terminal: "completed" },
  max_steps: { subtype: "error_max_turns", terminal: "max_turns" },
  // Garuda's budget counts tokens, not dollars, so error_max_budget_usd does not fit.
  token_budget: { subtype: "error_during_execution", terminal: "budget_exhausted" },
  repeated_calls: { subtype: "error_during_execution" },
};

export function resultLine(
  outcome: TurnOutcome,
  info: ResultInfo & {
    model: string;
    durationMs: number;
    lastText: string;
    denials: readonly PermissionDenial[];
  },
): Line {
  const result = outcome.kind === "done" ? outcome.result : undefined;
  const usage: Usage = result?.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const stop = result === undefined ? undefined : STOPS[result.stopReason];
  const subtype: Subtype = stop?.subtype ?? "error_during_execution";
  const errors =
    outcome.kind === "error"
      ? [outcome.message]
      : outcome.kind === "interrupted"
        ? ["Interrupted."]
        : subtype === "success"
          ? undefined
          : [info.stopMessage ?? `Stopped: ${result?.stopReason}`];
  return {
    type: "result",
    subtype,
    is_error: outcome.kind === "error",
    duration_ms: info.durationMs,
    duration_api_ms: Math.round(result?.apiMs ?? 0),
    num_turns: result?.steps ?? 0,
    ...(subtype === "success" ? { result: info.lastText } : {}),
    stop_reason: result?.modelStopReason ?? null,
    total_cost_usd: info.totalCostUsd,
    usage: apiUsage(usage),
    modelUsage: {
      [info.model]: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadTokens,
        cacheCreationInputTokens: usage.cacheWriteTokens,
        webSearchRequests: usage.webSearches ?? 0,
        costUSD: info.runCostUsd ?? 0,
        contextWindow: info.contextWindow,
        maxOutputTokens: info.maxOutputTokens,
      },
    },
    permission_denials: info.denials,
    ...(errors === undefined ? {} : { errors }),
    ...(stop?.terminal === undefined ? {} : { terminal_reason: stop.terminal }),
  };
}
