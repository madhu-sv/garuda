/**
 * Text from an MCP server is untrusted (0.2): tool names, descriptions, schemas and results.
 * Before it reaches the model or the terminal, Garuda removes what can hide or change meaning:
 * terminal escape sequences, control characters, bidirectional overrides, zero-width
 * characters and Unicode tag characters (a known way to hide prompt injections).
 */

// ESC sequences: CSI (ESC [ … final), OSC (ESC ] … BEL or ESC \), and two-byte ESC codes.
const ESCAPES =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]|\u009b[0-?]*[ -/]*[@-~]/g;
// C0 and C1 controls except tab and new line.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Bidi overrides and isolates, zero-width characters, and the BOM.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// Unicode tag characters (U+E0000–U+E007F).
const TAGS = /[\u{e0000}-\u{e007f}]/gu;

export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(ESCAPES, "")
    .replace(CONTROLS, "")
    .replace(INVISIBLE, "")
    .replace(TAGS, "");
}

/** Keep the start and the end of a long text, with a note in the middle. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - max} characters cut by Garuda …]\n${text.slice(-tail)}`;
}

/** Clean every string in a JSON value (keys too). */
export function cleanJson(value: unknown): unknown {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return value.map(cleanJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        cleanText(k),
        cleanJson(v),
      ]),
    );
  }
  return value;
}

/**
 * Outside text must not open or close Garuda's own markers: a fake </mcp_result> or
 * </web_result> could end a wrapper early, and a fake <garuda_note> could pose as Garuda.
 */
export function neutralizeTags(text: string): string {
  return text.replace(/<(\/?)(mcp_result|web_result|garuda_note|skill_file|skill)/gi, "<\\$1$2");
}
