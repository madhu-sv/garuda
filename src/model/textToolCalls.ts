/**
 * Tool calls written as text (0.3). Some small open models (for example qwen2.5-coder through
 * Ollama) write a tool call as JSON in the message text, not in the API's `tool_calls` field.
 * This module finds such calls. The mode comes from ~/.garuda/models.json ("textToolCalls"):
 *
 * - "whole" (default): the whole reply must be the call (or calls). Nothing else may be in it.
 * - "lines": calls may stand between lines of prose, each on its own line(s) or in its own fence
 *   or tag. The prose stays text. Use it for a model that explains before it calls.
 * - "off": text is always text.
 *
 * Both modes: each call names a tool of this request, and its arguments are a JSON object. A call
 * in the middle of a sentence never runs (it can be an example, or text quoted from a file).
 * A call found here passes the same input check, hooks and permission engine as any other call,
 * so it gets no extra power.
 *
 * Accepted forms, alone or in ```json fences or <tool_call> tags:
 *   {"name": "glob", "arguments": {"pattern": "*.ts"}}      ("parameters" also works)
 *   one object per line, or a JSON array of objects
 */

export type TextToolCallMode = "off" | "whole" | "lines";

export interface TextToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface TextToolCalls {
  calls: TextToolCall[];
  /** The text without the calls ("" in "whole" mode). */
  text: string;
}

/** The calls in `text`, or undefined when there are none under the mode's rules. */
export function extractTextToolCalls(
  text: string,
  toolNames: ReadonlySet<string>,
  mode: TextToolCallMode = "whole",
): TextToolCalls | undefined {
  if (mode === "off" || toolNames.size === 0) return undefined;
  if (mode === "whole") {
    const calls = wholeCalls(text.trim(), toolNames);
    return calls === undefined ? undefined : { calls, text: "" };
  }
  return lineCalls(text, toolNames);
}

/**
 * True while a streamed text can still become a tool call, so the adapter holds it back from
 * the screen. False as soon as the start of the text rules that out.
 */
export function mayBeToolCall(text: string): boolean {
  const start = text.trimStart();
  if (start === "") return true;
  if (START_TOKENS.some((token) => token.startsWith(start))) return true;
  return /^(?:<tool_call>\s*|```(?:json)?\s*)?[[{]/.test(start);
}

const START_TOKENS = ["<tool_call>", "```json", "```"];

/**
 * Decides which streamed text to show now. It holds back text that can still be a tool call:
 * in "whole" mode the reply until its start rules a call out; in "lines" mode everything from the
 * first line that can start a call. Other text passes at once.
 */
export class StreamHold {
  private held = "";
  /** "lines" mode: the current line, not yet decided. */
  private line = "";
  /** "lines" mode: the current line is not a call; show it as it comes. */
  private lineShown = false;
  private holdRest: boolean;
  private released = false;

  constructor(private readonly mode: TextToolCallMode) {
    this.holdRest = false;
    if (mode === "off") this.released = true;
  }

  /** Take new text; return the text to show now. */
  push(text: string): string {
    if (this.released) return text;
    if (this.holdRest) {
      this.held += text;
      return "";
    }
    if (this.mode === "whole") {
      this.held += text;
      if (mayBeToolCall(this.held)) return "";
      this.released = true;
      const out = this.held;
      this.held = "";
      return out;
    }
    return this.pushLines(text);
  }

  /** The text held back at the end. It starts at the start of a line. */
  rest(): string {
    return this.held + this.line;
  }

  private pushLines(text: string): string {
    this.line += text;
    let out = "";
    for (;;) {
      const newline = this.line.indexOf("\n");
      if (this.lineShown) {
        if (newline === -1) {
          out += this.line;
          this.line = "";
          return out;
        }
        out += this.line.slice(0, newline + 1);
        this.line = this.line.slice(newline + 1);
        this.lineShown = false;
        continue;
      }
      const current = newline === -1 ? this.line : this.line.slice(0, newline);
      if (current.trim() !== "" && !mayBeToolCall(current)) {
        this.lineShown = true;
        continue;
      }
      if (newline === -1) return out;
      if (current.trim() === "") {
        out += this.line.slice(0, newline + 1);
        this.line = this.line.slice(newline + 1);
        continue;
      }
      // A whole line that can start a call: hold from here to the end.
      this.holdRest = true;
      this.held = this.line;
      this.line = "";
      return out;
    }
  }
}

/** Longest JSON value (in lines) that "lines" mode tries to read. */
const MAX_JSON_LINES = 60;

function lineCalls(text: string, toolNames: ReadonlySet<string>): TextToolCalls | undefined {
  const lines = text.split("\n");
  const keep: string[] = [];
  const calls: TextToolCall[] = [];
  let i = 0;
  while (i < lines.length) {
    const found = callsAt(lines, i, toolNames);
    if (found === undefined) {
      keep.push(lines[i] ?? "");
      i++;
      continue;
    }
    // A fence or tag without calls stays text as a whole: a line inside it is never a call.
    if (found.calls.length === 0) keep.push(...lines.slice(i, found.next));
    calls.push(...found.calls);
    i = found.next;
  }
  if (calls.length === 0) return undefined;
  return {
    calls,
    text: keep
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}

/**
 * Calls that start at line `i` (a fence, a tag or a JSON value), and the line after them. A closed
 * fence or tag without calls gives no calls and the line after it.
 */
function callsAt(
  lines: readonly string[],
  i: number,
  toolNames: ReadonlySet<string>,
): { calls: TextToolCall[]; next: number } | undefined {
  const first = (lines[i] ?? "").trim();
  if (first.startsWith("```") || first.startsWith("<tool_call>")) {
    const closing = first.startsWith("```") ? "```" : "</tool_call>";
    for (let j = i; j < lines.length && j < i + MAX_JSON_LINES; j++) {
      const line = (lines[j] ?? "").trim();
      const closes = j === i ? line.length > 3 && line.endsWith(closing) : line.endsWith(closing);
      if (!closes) continue;
      const calls = wholeCalls(
        lines
          .slice(i, j + 1)
          .join("\n")
          .trim(),
        toolNames,
      );
      return { calls: calls ?? [], next: j + 1 };
    }
    return undefined;
  }
  if (!first.startsWith("{") && !first.startsWith("[")) return undefined;
  for (let j = i; j < lines.length && j < i + MAX_JSON_LINES; j++) {
    const calls = wholeCalls(
      lines
        .slice(i, j + 1)
        .join("\n")
        .trim(),
      toolNames,
    );
    if (calls !== undefined) return { calls, next: j + 1 };
  }
  return undefined;
}

/** "whole" mode: the calls when the text is only calls, else undefined. */
function wholeCalls(text: string, toolNames: ReadonlySet<string>): TextToolCall[] | undefined {
  const parts = unwrap(text);
  if (parts === undefined || parts.length === 0) return undefined;
  const calls: TextToolCall[] = [];
  for (const part of parts) {
    const values = parseJsonValues(part);
    if (values === undefined) return undefined;
    for (const value of values.flatMap((v) => (Array.isArray(v) ? v : [v]))) {
      const call = toCall(value, toolNames);
      if (call === undefined) return undefined;
      calls.push(call);
    }
  }
  return calls.length === 0 ? undefined : calls;
}

/** The JSON texts inside fences or tags; the whole text when it has none. */
function unwrap(text: string): string[] | undefined {
  if (text.startsWith("<tool_call>")) return blocks(text, /<tool_call>([\s\S]*?)<\/tool_call>/g);
  if (text.startsWith("```")) return blocks(text, /```(?:json)?[ \t]*\n?([\s\S]*?)```/g);
  return [text];
}

/** The inner texts of all matches; undefined when anything but white space lies between them. */
function blocks(text: string, pattern: RegExp): string[] | undefined {
  const inner: string[] = [];
  let rest = text;
  for (const match of text.matchAll(pattern)) {
    rest = rest.replace(match[0], "");
    inner.push((match[1] ?? "").trim());
  }
  return rest.trim() === "" ? inner : undefined;
}

/** One or more JSON values separated by white space, or undefined. */
function parseJsonValues(text: string): unknown[] | undefined {
  try {
    return [JSON.parse(text)];
  } catch {
    // Maybe one value per line.
  }
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length < 2) return undefined;
  const values: unknown[] = [];
  for (const line of lines) {
    try {
      values.push(JSON.parse(line));
    } catch {
      return undefined;
    }
  }
  return values;
}

function toCall(value: unknown, toolNames: ReadonlySet<string>): TextToolCall | undefined {
  if (!isObject(value)) return undefined;
  const name = value.name;
  if (typeof name !== "string" || !toolNames.has(name)) return undefined;
  let input = value.arguments ?? value.parameters ?? {};
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  return isObject(input) ? { name, input } : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
