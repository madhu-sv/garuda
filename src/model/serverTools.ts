import type { ContentBlock, ServerToolResultBlock, ServerToolUseBlock } from "./types.js";

/**
 * Provider-neutral text for server tool blocks (0.6: Claude's web search). Other providers, the
 * compaction transcript and old turns use it where the provider's blocks cannot go.
 */

/** The query of a web search call, or the input as JSON for another server tool. */
export function serverCallText(call: ServerToolUseBlock): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  return typeof input.query === "string" ? input.query : JSON.stringify(call.input);
}

/** "3 results" or "error max_uses_exceeded": one short line for the user. */
export function serverResultSummary(result: ServerToolResultBlock | undefined): string {
  if (result === undefined) return "runs with the next request";
  if (result.error !== undefined) return `error ${result.error}`;
  const n = result.results.length;
  return n === 0 ? "no results" : `${n} result${n === 1 ? "" : "s"}`;
}

/** A plain text block that says what a server search found: titles and URLs only. */
export function serverPairText(
  call: ServerToolUseBlock | undefined,
  result: ServerToolResultBlock,
): string {
  const head = `[Earlier ${result.name}${call === undefined ? "" : ` "${serverCallText(call)}"`}: ${serverResultSummary(result)}]`;
  return [head, ...result.results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}`)].join("\n");
}

/**
 * The blocks of an assistant message with each server call and result replaced by plain text, and
 * citations dropped (they point into the encrypted results). For other providers and for old turns.
 */
export function withoutServerBlocks(content: readonly ContentBlock[]): ContentBlock[] {
  const calls = new Map<string, ServerToolUseBlock>();
  for (const block of content) if (block.type === "server_tool_use") calls.set(block.id, block);
  const out: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === "server_tool_use") continue;
    if (block.type === "server_tool_result") {
      out.push({ type: "text", text: serverPairText(calls.get(block.toolUseId), block) });
    } else if (block.type === "text" && block.citations !== undefined) {
      out.push({ type: "text", text: block.text });
    } else out.push(block);
  }
  return out;
}

/** True when a message holds server tool blocks or citations. */
export function hasServerBlocks(content: readonly ContentBlock[]): boolean {
  return content.some(
    (b) =>
      b.type === "server_tool_use" ||
      b.type === "server_tool_result" ||
      (b.type === "text" && b.citations !== undefined),
  );
}
