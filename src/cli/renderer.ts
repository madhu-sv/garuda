import { styleText } from "node:util";
import type { AgentEvent } from "../loop/runAgent.js";
import { serverCallText, serverResultSummary } from "../model/serverTools.js";
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
  /**
   * /details (0.9): false hides the result line under each tool call, unless the call failed.
   * Absent: the renderer always shows them.
   */
  details?: boolean;
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
  /** /details (0.9): show the result line of each tool call. */
  details = true;

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
        if (this.details || event.outcome.isError) {
          this.line(
            `  ${this.paint("dim", "⎿")} ${event.outcome.isError ? this.paint("red", text) : this.paint("dim", text)}`,
          );
        }
        for (const line of todoLines(event.call, event.outcome)) this.line(`    ${line}`);
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
      case "notice":
        this.info(event.text);
        return;
      case "server_tool": {
        const { call, result } = serverToolText(event);
        const failed = event.result?.error !== undefined;
        this.line(`${this.paint("cyan", "●")} ${this.paint("bold", call)}`);
        if (this.details || failed) {
          this.line(`  ${this.paint("dim", "⎿")} ${this.paint(failed ? "red" : "dim", result)}`);
        }
        return;
      }
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

/** The steps of a todo list, with symbols, for the live view. Empty for other tools. */
export function todoLines(call: ToolUseBlock, outcome: ToolOutcome): string[] {
  if (call.name !== "todo_write" || outcome.isError) return [];
  const marks: Record<string, string> = { "[x]": "✔", "[>]": "▶", "[ ]": "○" };
  return outcome.content
    .split("\n")
    .map((line) => /^(\[[x> ]\]) (.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `${marks[m[1] ?? ""] ?? "○"} ${m[2] ?? ""}`);
}

/** Two short lines for a server tool call (0.6): `web_search (Claude) "query"`, `5 results`. */
export function serverToolText(event: Extract<AgentEvent, { type: "server_tool" }>): {
  call: string;
  result: string;
} {
  return {
    call: `${event.call.name} (Claude) ${cut(serverCallText(event.call), 100)}`,
    result: serverResultSummary(event.result),
  };
}

/** The pages a server search found, for Ctrl-O. */
export function serverToolOutput(event: Extract<AgentEvent, { type: "server_tool" }>): string {
  const result = event.result;
  if (result === undefined || result.results.length === 0) return serverResultSummary(result);
  return result.results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.age === undefined ? "" : ` (${r.age})`}`)
    .join("\n");
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
    case "todo_write": {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      return `${todos.length} step(s)`;
    }
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
    case "todo_write":
      return /\((\d+ of \d+ done)\)/.exec(first)?.[1] ?? first;
    case "web_search": {
      const count = outcome.content.split("\n").filter((l) => /^\d+\. /.test(l)).length;
      return count === 0 ? "no results" : `${count} result${count === 1 ? "" : "s"}`;
    }
    case "web_fetch": {
      // "<web_result url=… title="T">" then "[characters a–b of n]".
      const title = / title="([^"]*)"/.exec(first)?.[1];
      const range = /^\[characters (\d+)–(\d+) of (\d+)\]$/m.exec(outcome.content);
      const size =
        range === null
          ? `${lines} line(s)`
          : range[1] === "0" && range[2] === range[3]
            ? `${Number(range[3]).toLocaleString("en")} characters`
            : `characters ${range[1]}–${range[2]} of ${Number(range[3]).toLocaleString("en")}`;
      return title === undefined ? size : `${cut(title, 80)} · ${size}`;
    }
    case "skill": {
      const file = / path="([^"]*)"/.exec(first)?.[1];
      const name = / name="([^"]*)"/.exec(first)?.[1] ?? / skill="([^"]*)"/.exec(first)?.[1];
      return file === undefined ? `loaded ${name ?? "the skill"}` : `read ${file}`;
    }
    case "agent": {
      // The answer's size and the run's trailer: "[agent reviewer: 4 steps · 9.1k tokens]".
      const trailer = /^\[agent (.*)\]$/m.exec(outcome.content)?.[1];
      const answerLines = outcome.content.split("\n[agent ")[0]?.trim().split("\n").length ?? 0;
      return `answer (${answerLines} line(s))${trailer === undefined ? "" : ` · ${trailer}`}`;
    }
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
