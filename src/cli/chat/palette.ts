import { fuzzyFiles } from "./complete.js";

/**
 * The command palette (0.9, Ctrl-P in the Ink chat): all commands with their one-line help. Typing
 * filters them; Enter runs a command that needs no arguments, or puts `/name ` in the input line.
 */

/** One row. `runs`: Enter runs it; otherwise it goes in the line for its arguments. */
export interface PaletteEntry {
  name: string;
  hint: string;
  runs: boolean;
}

export interface PaletteState {
  query: string;
  /** The rows that match the query, best first. */
  entries: PaletteEntry[];
  selected: number;
}

/** Rows shown at once. */
export const PALETTE_ROWS = 10;

/**
 * The rows for a query: names by the fuzzy search of `@` (letters in order, starts of words first),
 * then rows whose help holds the query. An empty query keeps the order of the list.
 */
export function filterPalette(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const q = query.trim().replace(/^\//, "").toLowerCase();
  if (q === "") return [...entries];
  const byName = new Map(entries.map((e) => [e.name, e]));
  const names = fuzzyFiles(q, [...byName.keys()], entries.length);
  const out = names.flatMap((n) => {
    const entry = byName.get(n);
    return entry === undefined ? [] : [entry];
  });
  for (const entry of entries) {
    if (!out.includes(entry) && entry.hint.toLowerCase().includes(q)) out.push(entry);
  }
  return out;
}

/** The first row to show, so that the selected row stays in view. */
export function paletteWindow(selected: number, count: number): number {
  if (count <= PALETTE_ROWS) return 0;
  return Math.min(Math.max(0, selected - PALETTE_ROWS + 1), count - PALETTE_ROWS);
}
