import { cleanText } from "../mcp/sanitize.js";
import type { Diagnostic } from "./client.js";

/** Most error lines in one edit result. */
export const MAX_ERROR_LINES = 20;
const MAX_MESSAGE_CHARS = 300;

/**
 * The text that goes after an edit result (0.4): errors only. A diagnostic with no severity
 * counts as an error (the LSP says the client decides). Messages are server text, so they are
 * cleaned like other outside text.
 */
export function formatDiagnostics(shown: string, server: string, items: Diagnostic[]): string {
  const errors = items
    .filter((d) => d.severity === undefined || d.severity === 1)
    .sort((a, b) => a.line - b.line || a.character - b.character);
  if (errors.length === 0) return `No errors in ${shown} (${server}).`;
  const lines = errors.slice(0, MAX_ERROR_LINES).map((d) => {
    const first = cleanText(d.message).split("\n")[0]?.trim() ?? "";
    const message =
      first.length > MAX_MESSAGE_CHARS ? `${first.slice(0, MAX_MESSAGE_CHARS)}…` : first;
    const code = d.code === undefined ? "" : ` [${cleanText(String(d.code))}]`;
    return `  ${d.line}:${d.character} ${message}${code}`;
  });
  if (errors.length > MAX_ERROR_LINES) {
    lines.push(`  … and ${errors.length - MAX_ERROR_LINES} more.`);
  }
  const noun = errors.length === 1 ? "error" : "errors";
  return [`${errors.length} ${noun} in ${shown} after this change (${server}):`, ...lines].join(
    "\n",
  );
}
