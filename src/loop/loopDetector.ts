import type { ToolUseBlock } from "../model/types.js";

/** F7: this many identical tool calls in a row stop the run. */
export const REPEAT_LIMIT = 3;

/** Tool name and input, with object keys sorted, so equal calls give equal text (F7). */
export function signature(call: ToolUseBlock): string {
  return `${call.name} ${stableJson(call.input)}`;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function repeated(recent: readonly string[], limit = REPEAT_LIMIT): boolean {
  if (recent.length < limit) return false;
  const last = recent.slice(-limit);
  return last.every((s) => s === last[0]);
}
