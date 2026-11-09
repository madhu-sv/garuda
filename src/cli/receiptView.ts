import type { Receipt } from "../app/receipt.js";
import { formatUsd } from "./report.js";

/**
 * The receipt of a turn as text (UX U1; docs/lld/ux.md). Pure: facts in, text out. A box from 60
 * columns; under 60, without a terminal, or in screen-reader mode, one plain line per row. Color is
 * never the only signal: every state also has a word or a mark.
 */

export type ReceiptStyle = "dim" | "green" | "red" | "yellow" | "bold" | "accent";

export interface ReceiptViewOptions {
  /** The terminal's columns; undefined (no terminal) gives plain lines. */
  columns?: number;
  /** Colors; absent gives plain text (NO_COLOR, pipes). */
  paint?: (style: ReceiptStyle, text: string) => string;
  /** UX U12: no box. */
  screenReader?: boolean;
}

/** UX U12: GARUDA_SCREEN_READER=1 gives plain lines with no box. */
export function screenReaderMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GARUDA_SCREEN_READER === "1";
}

/** Below this width the box does not fit well: plain lines. */
export const RECEIPT_BOX_MIN_COLUMNS = 60;
/** The box is never wider than this. */
export const RECEIPT_MAX_WIDTH = 76;

/** A piece of a row: text, and its style. */
type Part = [text: string, style?: ReceiptStyle];

interface Row {
  label: string;
  parts: Part[];
}

const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} s`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The width of a text in terminal cells: wide characters (CJK, emoji) take two. Marks such as ⛨
 * and ✓ take one in common terminals.
 */
export function cells(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff) ||
      (c >= 0x20000 && c <= 0x3fffd);
    n += wide ? 2 : 1;
  }
  return n;
}

/** Cut a text to `width` cells, with "…" at the end when cut. */
function cut(text: string, width: number): string {
  if (cells(text) <= width) return text;
  let out = "";
  for (const ch of text) {
    if (cells(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}

function filesParts(receipt: Receipt, room: number): Part[] {
  const files = receipt.files;
  if (files === undefined) return [["undo is off: no file list", "dim"]];
  if (files.length === 0) return [["no file changed", "dim"]];
  const shown: string[] = [];
  for (const [i, f] of files.entries()) {
    const lines = f.added === undefined ? " (binary)" : ` +${f.added} −${f.removed ?? 0}`;
    const item = `${f.path}${lines}`;
    const rest = files.length - i - 1;
    const tail = rest > 0 ? ` · ${rest} more` : "";
    const next = [...shown, item].join(" · ");
    if (shown.length > 0 && cells(next + tail) > room) {
      shown.push(`${files.length - i} more`);
      return [[shown.join(" · ")]];
    }
    shown.push(item);
  }
  return [[shown.join(" · ")]];
}

function testsParts(receipt: Receipt): Part[] | undefined {
  const t = receipt.tests;
  if (t === undefined) return undefined;
  const count =
    t.total === undefined
      ? ""
      : t.passed
        ? ` (${plural(t.total, "test")}${t.previousTotal !== undefined && t.previousTotal !== t.total ? `, was ${t.previousTotal}` : ""})`
        : (t.failed ?? 0) > 0
          ? ` (${t.failed} of ${t.total})`
          : ` (${plural(t.total, "test")})`;
  return t.passed
    ? [[`${t.command} `], ["✓ passed", "green"], [count]]
    : [[`${t.command} `], [t.timedOut === true ? "✗ timed out" : "✗ failed", "red"], [count]];
}

function sandboxParts(receipt: Receipt): Part[] | undefined {
  const c = receipt.commands;
  if (c.sandboxed + c.outside === 0) return undefined;
  const parts: Part[] = [
    [`⛨ ${plural(c.sandboxed, "command")} in the sandbox · `],
    c.outside > 0 ? [`${c.outside} outside`, "yellow"] : [`${c.outside} outside`],
  ];
  return parts;
}

function rows(receipt: Receipt, room: number): Row[] {
  const out: Row[] = [{ label: "Files", parts: filesParts(receipt, room) }];
  const tests = testsParts(receipt);
  if (tests !== undefined) out.push({ label: "Tests", parts: tests });
  const sandbox = sandboxParts(receipt);
  if (sandbox !== undefined) out.push({ label: "Sandbox", parts: sandbox });
  const hosts = receipt.commands.blockedHosts;
  if (hosts.length > 0) {
    out.push({ label: "Network", parts: [[`blocked ${hosts.join(", ")}`, "yellow"]] });
  }
  const changed = receipt.files?.length ?? 0;
  if (changed > 0)
    out.push({ label: "Undo", parts: [[`/undo puts back ${plural(changed, "file")}`]] });
  return out;
}

function headText(receipt: Receipt): string {
  return `Turn ${receipt.turn} · ${receipt.stopReason} · ${plural(receipt.steps, "step")} · ${seconds(receipt.durationMs)}`;
}

function footText(receipt: Receipt): string {
  const parts = [`context ${receipt.contextPercent}%`];
  if (receipt.sessionCostUsd !== undefined) {
    parts.push(
      `session ${formatUsd(receipt.sessionCostUsd, receipt.sessionCostIncomplete === true)}`,
    );
  }
  const kept = receipt.keptChanges ?? 0;
  if (kept > 0) {
    parts.push(plural(kept, "kept change"));
    if (receipt.sessionCostUsd !== undefined) {
      const each = formatUsd(receipt.sessionCostUsd / kept, receipt.sessionCostIncomplete === true);
      parts.push(`${each} each`);
    }
  }
  return parts.join(" · ");
}

/** The receipt as text, ready to print. */
export function receiptText(receipt: Receipt, options: ReceiptViewOptions = {}): string {
  const paint = options.paint ?? ((_style: ReceiptStyle, text: string) => text);
  const draw = (parts: Part[]) =>
    parts.map(([text, style]) => (style === undefined ? text : paint(style, text))).join("");
  const cost = formatUsd(receipt.costUsd, receipt.costIncomplete === true);
  const columns = options.columns;
  if (options.screenReader === true || columns === undefined || columns < RECEIPT_BOX_MIN_COLUMNS) {
    const lines = [`${headText(receipt)} · ${cost}`];
    for (const row of rows(receipt, 200)) lines.push(`${row.label}: ${draw(row.parts)}`);
    lines.push(footText(receipt));
    return lines.join("\n");
  }
  const width = Math.min(columns, RECEIPT_MAX_WIDTH);
  const label = 9;
  // "│ " + label + text + " │"
  const room = width - 4 - label;
  // UX U12: the border in the chat's accent (yellow on a 16-color terminal).
  const border = (text: string) => paint("accent", text);
  // "╭─ head ───── $0.0041 ─╮" and "╰─ foot ──────────────╯", each `width` cells.
  const edge = (left: string, text: string, right: string, end: string) => {
    const tail = right === "" ? "" : ` ${right} ─`;
    const head = cut(text, width - 4 - cells(tail) - cells(end) - 1);
    const fill = width - 3 - cells(head) - 1 - cells(tail) - cells(end);
    return `${border(`${left}─ `)}${head} ${border("─".repeat(Math.max(1, fill)))}${right === "" ? "" : ` ${right} ${border("─")}`}${border(end)}`;
  };
  const out = [edge("╭", headText(receipt), cost, "╮")];
  for (const row of rows(receipt, room)) {
    const plain = row.parts.map(([text]) => text).join("");
    let parts = row.parts;
    if (cells(plain) > room) parts = [[cut(plain, room)]];
    const shown = parts.map(([text]) => text).join("");
    const pad = " ".repeat(Math.max(0, room - cells(shown)));
    out.push(
      `${border("│")} ${paint("dim", row.label.padEnd(label))}${draw(parts)}${pad} ${border("│")}`,
    );
  }
  out.push(edge("╰", footText(receipt), "", "╯"));
  return out.join("\n");
}
