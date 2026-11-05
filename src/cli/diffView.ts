/**
 * Diffs for the terminal (UX U5; docs/lld/ux.md): a unified diff with the changed words marked in
 * changed lines, and from 140 columns a side-by-side view with the line numbers of both sides.
 * Pure: a `paint` function gives the colours, so tests and NO_COLOR get plain text.
 */

export type DiffStyle = "red" | "green" | "cyan" | "bold" | "dim" | "inverse";
export type DiffPaint = (styles: readonly DiffStyle[], text: string) => string;

/** From this width, a diff is shown side by side (decision D8). */
export const SIDE_BY_SIDE_COLUMNS = 140;

/** Words, runs of spaces, and single other characters: the units of a word diff. */
export function tokens(line: string): string[] {
  return line.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

/** Most token pairs that a word diff compares; a longer pair of lines is not marked. */
const MAX_CELLS = 40_000;

/**
 * Which tokens of `a` and of `b` are not in their longest common subsequence: the changed words.
 * Undefined when the lines have too little in common to be worth marking (under 40% of the
 * tokens), or are too long.
 */
export function wordDiff(
  a: string,
  b: string,
):
  | { a: { text: string; changed: boolean }[]; b: { text: string; changed: boolean }[] }
  | undefined {
  const x = tokens(a);
  const y = tokens(b);
  if (x.length * y.length > MAX_CELLS || x.length + y.length === 0) return undefined;
  // LCS lengths from the end.
  const n = x.length;
  const m = y.length;
  const table = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] =
        x[i] === y[j]
          ? (table[at(i + 1, j + 1)] ?? 0) + 1
          : Math.max(table[at(i + 1, j)] ?? 0, table[at(i, j + 1)] ?? 0);
    }
  }
  const common = table[at(0, 0)] ?? 0;
  const solid = (t: string[]) => t.filter((s) => s.trim() !== "").length;
  if (common === 0 || common / Math.max(1, Math.max(solid(x), solid(y))) < 0.4) return undefined;
  const outA: { text: string; changed: boolean }[] = [];
  const outB: { text: string; changed: boolean }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      outA.push({ text: x[i] as string, changed: false });
      outB.push({ text: y[j] as string, changed: false });
      i++;
      j++;
    } else if (j < m && (i >= n || (table[at(i, j + 1)] ?? 0) >= (table[at(i + 1, j)] ?? 0))) {
      outB.push({ text: y[j] as string, changed: true });
      j++;
    } else {
      outA.push({ text: x[i] as string, changed: true });
      i++;
    }
  }
  return { a: outA, b: outB };
}

/** Join tokens into runs, so a marked word is one escape sequence, not one per character. */
function paintParts(
  parts: { text: string; changed: boolean }[],
  base: DiffStyle,
  paint: DiffPaint,
): string {
  const runs: { text: string; changed: boolean }[] = [];
  for (const p of parts) {
    // A space between two changed words is marked with them; a lone changed space is not.
    const last = runs.at(-1);
    if (last !== undefined && last.changed === p.changed) last.text += p.text;
    else runs.push({ ...p });
  }
  return runs
    .map((r) =>
      r.changed && r.text.trim() !== "" ? paint([base, "inverse"], r.text) : paint([base], r.text),
    )
    .join("");
}

/**
 * A unified diff with colours: + green, - red, hunk headers cyan, file headers bold. In a run of
 * removed lines followed by added lines, the n-th removed and the n-th added line are a pair, and
 * their changed words are marked (inverse video).
 */
export function unifiedDiff(text: string, paint: DiffPaint): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isFileHeader(line)) {
      out.push(paint(["bold"], line));
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      out.push(paint(["cyan"], line));
      i++;
      continue;
    }
    if (line.startsWith("-")) {
      const removed: string[] = [];
      while (i < lines.length && isRemoved(lines[i] as string)) removed.push(lines[i++] as string);
      const added: string[] = [];
      while (i < lines.length && isAdded(lines[i] as string)) added.push(lines[i++] as string);
      const marks = removed.map((r, k) => {
        const a = added[k];
        return a === undefined ? undefined : wordDiff(r.slice(1), a.slice(1));
      });
      removed.forEach((r, k) => {
        const m = marks[k];
        out.push(
          m === undefined ? paint(["red"], r) : paint(["red"], "-") + paintParts(m.a, "red", paint),
        );
      });
      added.forEach((a, k) => {
        const m = marks[k];
        out.push(
          m === undefined
            ? paint(["green"], a)
            : paint(["green"], "+") + paintParts(m.b, "green", paint),
        );
      });
      continue;
    }
    out.push(line.startsWith("+") ? paint(["green"], line) : line);
    i++;
  }
  return out.join("\n");
}

const isFileHeader = (line: string) =>
  line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git");
const isRemoved = (line: string) => line.startsWith("-") && !line.startsWith("---");
const isAdded = (line: string) => line.startsWith("+") && !line.startsWith("+++");

/** Cut a text to `width` characters, with "…" at the end when cut; else pad it to `width`. */
function fitWidth(text: string, width: number): string {
  const chars = [...text];
  if (chars.length > width) return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
  return text + " ".repeat(width - chars.length);
}

/**
 * Side by side (UX U5 step 2): the old file on the left, the new on the right, each with its line
 * numbers from the hunk headers. Removed and added lines in a run sit on the same row; a run that
 * is longer on one side leaves the other side empty. File headers and hunk headers span the width.
 */
export function sideBySide(text: string, columns: number, paint: DiffPaint): string {
  const half = Math.floor((columns - 3) / 2);
  const body = half - 6;
  const out: string[] = [];
  let oldNo = 0;
  let newNo = 0;
  const cell = (no: number | undefined, mark: string, content: string, style?: DiffStyle) => {
    const head = no === undefined ? "     " : String(no).padStart(4);
    const shown = fitWidth(`${mark}${content}`, body + 1);
    return `${paint(["dim"], head)} ${style === undefined ? shown : paint([style], shown)}`;
  };
  const markedCell = (
    no: number,
    sign: string,
    parts: { text: string; changed: boolean }[],
    style: DiffStyle,
  ) => {
    // Cut the plain text first, then paint the runs that are left.
    let room = body;
    const kept: { text: string; changed: boolean }[] = [];
    for (const p of parts) {
      if (room <= 0) break;
      const chars = [...p.text];
      const piece =
        chars.length > room ? `${chars.slice(0, Math.max(0, room - 1)).join("")}…` : p.text;
      kept.push({ text: piece, changed: p.changed });
      room -= [...piece].length;
    }
    const pad = " ".repeat(Math.max(0, room));
    return `${paint(["dim"], String(no).padStart(4))} ${paint([style], sign)}${paintParts(kept, style, paint)}${pad}`;
  };
  const empty = " ".repeat(half);
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isFileHeader(line)) {
      out.push(paint(["bold"], line));
      i++;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push(paint(["cyan"], line));
      i++;
      continue;
    }
    if (isRemoved(line) || isAdded(line)) {
      const removed: string[] = [];
      while (i < lines.length && isRemoved(lines[i] as string)) removed.push(lines[i++] as string);
      const added: string[] = [];
      while (i < lines.length && isAdded(lines[i] as string)) added.push(lines[i++] as string);
      for (let k = 0; k < Math.max(removed.length, added.length); k++) {
        const r = removed[k];
        const a = added[k];
        const m = r !== undefined && a !== undefined ? wordDiff(r.slice(1), a.slice(1)) : undefined;
        const left =
          r === undefined
            ? empty
            : m !== undefined
              ? markedCell(oldNo++, "-", m.a, "red")
              : cell(oldNo++, "-", r.slice(1), "red");
        const right =
          a === undefined
            ? ""
            : m !== undefined
              ? markedCell(newNo++, "+", m.b, "green")
              : cell(newNo++, "+", a.slice(1), "green");
        out.push(`${left} ${paint(["dim"], "│")} ${right}`.trimEnd());
      }
      continue;
    }
    if (line.startsWith("\\")) {
      out.push(paint(["dim"], line));
      i++;
      continue;
    }
    // A context line (or an empty one at the end of the text).
    if (i === lines.length - 1 && line === "") break;
    const content = line.startsWith(" ") ? line.slice(1) : line;
    out.push(
      `${cell(oldNo++, " ", content)} ${paint(["dim"], "│")} ${cell(newNo++, " ", content)}`.trimEnd(),
    );
    i++;
  }
  return out.join("\n");
}

/** The diff for this terminal: side by side from SIDE_BY_SIDE_COLUMNS, else unified. */
export function terminalDiff(text: string, columns: number | undefined, paint: DiffPaint): string {
  return columns !== undefined && columns >= SIDE_BY_SIDE_COLUMNS
    ? sideBySide(text, columns, paint)
    : unifiedDiff(text, paint);
}

/** How many hunks a diff has (UX U5: "3 hunks · h reviews them one by one"). */
export function hunkCount(text: string): number {
  return text.split("\n").filter((line) => line.startsWith("@@")).length;
}
