import { styleText } from "node:util";
import type { AgentEvent } from "../loop/runAgent.js";
import type { ToolUseBlock } from "../model/types.js";
import type { ToolOutcome } from "../tools/types.js";

/**
 * The renderer (F3): it shows model text and tool activity as they happen.
 * 0.1 prints plain lines. 0.2 can add an Ink renderer with the same interface.
 */
export interface Renderer {
  event(event: AgentEvent): void;
  info(text: string): void;
  warn(text: string): void;
  error(text: string): void;
}

type Style = Parameters<typeof styleText>[0];

export interface Streams {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
}

/**
 * Model text goes to stdout, so `garuda -p … > answer.md` keeps only the answer.
 * Tool activity, notes and errors go to stderr.
 */
export class PlainRenderer implements Renderer {
  private readonly out: NodeJS.WritableStream;
  private readonly err: NodeJS.WritableStream;
  private readonly color: boolean;
  /** True when the last text did not end with a new line. */
  private openLine = false;

  constructor(
    streams: Streams = { out: process.stdout, err: process.stderr },
    color = process.stderr.isTTY === true && !process.env.NO_COLOR,
  ) {
    this.out = streams.out;
    this.err = streams.err;
    this.color = color;
  }

  event(event: AgentEvent): void {
    switch (event.type) {
      case "text_delta":
        this.out.write(event.text);
        this.openLine = !event.text.endsWith("\n");
        return;
      case "tool_call":
        this.line(
          `${this.paint("cyan", "●")} ${this.paint("bold", event.call.name)} ${summariseCall(event.call)}`,
        );
        return;
      case "tool_result": {
        const text = summariseResult(event.call, event.outcome);
        this.line(
          `  ${this.paint("dim", "⎿")} ${event.outcome.isError ? this.paint("red", text) : this.paint("dim", text)}`,
        );
        return;
      }
      case "compaction": {
        const { stage, beforeTokens, afterTokens } = event.result;
        this.info(`Context compacted (${stage}): ${beforeTokens} → about ${afterTokens} tokens.`);
        return;
      }
      case "model_retry":
        this.warn(retryText(event));
        return;
      case "step_end":
      // Live status lines need a live view; plain output stays one line per call.
      case "tool_progress":
        return;
    }
  }

  info(text: string): void {
    this.line(this.paint("dim", text));
  }

  warn(text: string): void {
    this.line(this.paint("yellow", text));
  }

  error(text: string): void {
    this.line(this.paint("red", text));
  }

  /** A line on stderr. It starts on a new line if model text is still open. */
  private line(text: string): void {
    if (this.openLine) {
      this.out.write("\n");
      this.openLine = false;
    }
    this.err.write(`${text}\n`);
  }

  private paint(style: Style, text: string): string {
    return this.color ? styleText(style, text) : text;
  }
}

/** The notice for a retry of a broken model stream. */
export function retryText(event: { attempt: number; maxRetries: number; reason: string }): string {
  return `The connection to the model broke (${event.reason}). Retrying (${event.attempt}/${event.maxRetries})…`;
}

const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** One short line that says what a call does. */
export function summariseCall(call: ToolUseBlock): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (call.name) {
    case "read_file":
    case "write_file":
    case "edit_file":
      return str("path");
    case "glob":
      return str("pattern");
    case "grep":
      return `/${str("pattern")}/${str("path") ? ` in ${str("path")}` : ""}`;
    case "bash":
      return cut(str("command").split("\n")[0] ?? "", 100);
    case "explore":
      return cut(str("question").split("\n")[0] ?? "", 100);
    default:
      return cut(JSON.stringify(call.input), 100);
  }
}

/** One short line that says what a call returned. */
export function summariseResult(call: ToolUseBlock, outcome: ToolOutcome): string {
  // MCP results start with their <mcp_result …> marker: show the first line inside it.
  const all = outcome.content.split("\n");
  const first = ((all[0]?.startsWith("<mcp_result ") ? all[1] : all[0]) ?? "").trim();
  if (outcome.isError) return cut(first.replace(/^Error: /, ""), 160);
  const lines = outcome.content === "" ? 0 : outcome.content.split("\n").length;
  switch (call.name) {
    case "read_file":
      return `${lines} line(s)`;
    case "glob":
    case "grep":
      return first.startsWith("No ") ? first : `${lines} result line(s)`;
    case "bash":
      return first;
    case "explore": {
      // The answer's size and the run's trailer: "[explore: 7 steps · 12.3k tokens]".
      const trailer = /^\[explore: (.*)\]$/m.exec(outcome.content)?.[1];
      const answerLines = outcome.content.split("\n[explore: ")[0]?.trim().split("\n").length ?? 0;
      return `answer (${answerLines} line(s))${trailer === undefined ? "" : ` · ${trailer}`}`;
    }
    default:
      return cut(first, 160);
  }
}
