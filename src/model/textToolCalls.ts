/**
 * Tool calls written as text (0.3). Some small open models (for example qwen2.5-coder through
 * Ollama) write a tool call as JSON in the message text, not in the API's `tool_calls` field.
 * This module finds such calls, under strict rules:
 *
 * - The whole message is the call (or calls). A call inside prose is never run: the model may
 *   only be showing an example, or quoting text from a file.
 * - Each call names a tool from this request, and its arguments are a JSON object.
 * - If any part fails a rule, nothing is a call and the text stays text.
 *
 * A call found here goes through the same input check, hooks and permission engine as any other
 * call, so it gets no extra power.
 *
 * Accepted forms, alone or in ```json fences or <tool_call> tags:
 *   {"name": "glob", "arguments": {"pattern": "*.ts"}}      ("parameters" also works)
 *   one object per line, or a JSON array of objects
 */

export interface TextToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** The calls in `text`, or undefined when the text is not only tool calls. */
export function textToolCalls(
  text: string,
  toolNames: ReadonlySet<string>,
): TextToolCall[] | undefined {
  const parts = unwrap(text.trim());
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
