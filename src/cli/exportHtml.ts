import { hasReceipt } from "../app/receipt.js";
import { serverCallText, serverResultSummary } from "../model/serverTools.js";
import type { ToolUseBlock } from "../model/types.js";
import type { SessionRecord } from "../session/records.js";
import { receiptText } from "./receiptView.js";
import { summariseCall, summariseResult } from "./renderer.js";

/**
 * /export --html (UX U11; docs/lld/ux.md): the session as one self-contained page, to attach to a
 * pull request. It comes from the session file, so secrets are redacted as in the Markdown export.
 * Every text is escaped; the page has no script, no link and no outside resource, so a reader's
 * browser runs nothing from it. Tool calls open to show their output; edits show their change.
 */

/** Escape for HTML text and attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Most characters of one tool output on the page. */
export const OUTPUT_CHARS = 4_000;

const cutOutput = (text: string) =>
  text.length <= OUTPUT_CHARS
    ? text
    : `${text.slice(0, OUTPUT_CHARS)}\n… ${text.length - OUTPUT_CHARS} more characters in the session file.`;

/** The change of an edit_file or write_file call, as diff lines: - old, + new. */
export function callChange(call: ToolUseBlock): string | undefined {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const lines = (text: unknown, sign: string) =>
    typeof text === "string" ? text.split("\n").map((l) => `${sign}${l}`) : [];
  if (call.name === "edit_file") {
    return [...lines(input.old_string, "-"), ...lines(input.new_string, "+")].join("\n");
  }
  if (call.name === "write_file") return lines(input.content, "+").join("\n");
  return undefined;
}

/** Diff lines with a class each, for the page's colours. */
function diffHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
      return `<span class="${cls}">${escapeHtml(line)}</span>`;
    })
    .join("\n");
}

const STYLE = `
:root { --bg: #fbf7ef; --fg: #222; --dim: #6b6b6b; --line: #e4dccb; --accent: #d97706;
  --add: #e6f4e6; --addfg: #17602a; --del: #fbe7e7; --delfg: #8f1d1d; --you: #0e7490; }
@media (prefers-color-scheme: dark) { :root { --bg: #1d1d1b; --fg: #e8e4dc; --dim: #a19c92;
  --line: #3a3833; --add: #183522; --addfg: #9ee2ad; --del: #3b1d1d; --delfg: #f4a9a9; } }
body { background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, sans-serif;
  max-width: 920px; margin: 32px auto; padding: 0 16px; }
h1 { font-size: 20px; } .meta { color: var(--dim); font-size: 13px; }
.you { border-left: 4px solid var(--you); padding: 4px 12px; margin: 24px 0 8px; font-weight: 600;
  white-space: pre-wrap; }
.answer { white-space: pre-wrap; margin: 8px 0; }
.answer::before { content: "✦ "; color: var(--accent); }
details { border: 1px solid var(--line); border-radius: 6px; margin: 6px 0; padding: 4px 10px; }
summary { cursor: pointer; font-family: ui-monospace, monospace; font-size: 13px; }
pre { font: 12.5px/1.45 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere;
  margin: 6px 0; }
.add { background: var(--add); color: var(--addfg); display: inline-block; width: 100%; }
.del { background: var(--del); color: var(--delfg); display: inline-block; width: 100%; }
.receipt { border: 1px solid var(--accent); border-radius: 6px; padding: 6px 10px; }
.note { color: var(--dim); font-style: italic; }
.failed summary { color: var(--delfg); }
`;

/** The page for a session's records. */
export function sessionHtml(records: readonly SessionRecord[], sessionId: string): string {
  const body: string[] = [];
  const start = records.find((r) => r.type === "start");
  body.push(`<h1>Garuda session ${escapeHtml(sessionId)}</h1>`);
  if (start?.type === "start") {
    body.push(
      `<p class="meta">${escapeHtml(start.root)} · ${escapeHtml(start.model)} · ${escapeHtml(start.t)}</p>`,
    );
  }
  const calls = new Map<string, ToolUseBlock>();
  for (const record of records) {
    switch (record.type) {
      case "user": {
        const prompt = record.message.content[0];
        body.push(
          `<div class="you">${escapeHtml(prompt?.type === "text" ? prompt.text : "")}</div>`,
        );
        break;
      }
      case "assistant":
        for (const block of record.response.content) {
          if (block.type === "text" && block.text.trim() !== "") {
            body.push(`<div class="answer">${escapeHtml(block.text.trim())}</div>`);
          }
          if (block.type === "tool_use") calls.set(block.id, block);
          if (block.type === "server_tool_result") {
            const call = record.response.content.find(
              (b) => b.type === "server_tool_use" && b.id === block.toolUseId,
            );
            const query = call?.type === "server_tool_use" ? ` ${serverCallText(call)}` : "";
            // Pages as text, not links: the page opens nothing by itself.
            const pages = block.results.map((r) => `${r.title}\n  ${r.url}`).join("\n");
            body.push(
              `<details><summary>${escapeHtml(`● ${block.name} (Claude)${query} → ${serverResultSummary(block)}`)}</summary><pre>${escapeHtml(pages)}</pre></details>`,
            );
          }
        }
        break;
      case "tool_results":
        for (const block of record.message.content) {
          if (block.type !== "tool_result") continue;
          const call = calls.get(block.toolUseId);
          if (call === undefined) continue;
          const summary = summariseResult(call, { content: block.content, isError: block.isError });
          const head = `● ${[call.name, summariseCall(call)].filter((p) => p !== "").join(" ")} → ${block.isError ? `failed: ${summary}` : summary}`;
          const change = callChange(call);
          const inner =
            change === undefined
              ? `<pre>${escapeHtml(cutOutput(block.content))}</pre>`
              : `<pre>${diffHtml(cutOutput(change))}</pre>`;
          body.push(
            `<details${block.isError ? ' class="failed"' : ""}><summary>${escapeHtml(head)}</summary>${inner}</details>`,
          );
        }
        break;
      case "receipt":
        if (hasReceipt(record.receipt)) {
          body.push(`<pre class="receipt">${escapeHtml(receiptText(record.receipt))}</pre>`);
        }
        break;
      case "undo":
        body.push('<p class="note">/undo: the last turn was taken back.</p>');
        break;
      case "redo":
        body.push('<p class="note">/redo: the turn came back.</p>');
        break;
      case "compaction":
        body.push('<p class="note">The conversation was compacted here.</p>');
        break;
      case "fork":
        body.push(
          `<p class="note">This session starts as a fork of session ${escapeHtml(record.from.sessionId)}, at turn ${record.from.turn}.</p>`,
        );
        break;
      default:
        break;
    }
  }
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // No script may run, and nothing loads from outside: the page's own policy says so too.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    `<title>Garuda session ${escapeHtml(sessionId)}</title>`,
    `<style>${STYLE}</style></head><body>`,
    ...body,
    "</body></html>",
    "",
  ].join("\n");
}
