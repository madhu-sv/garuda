/**
 * Interactive hunk-by-hunk patch staging (0.14).
 * Parses unified diffs into discrete reviewable hunks, tracks per-hunk staging state,
 * and provides navigation and staging operations for the Ink chat UI.
 */

export interface HunkItem {
  readonly id: number;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly header: string;
  readonly heading: string;
  readonly lines: readonly string[];
  staged: boolean;
}

export interface HunkStagingState {
  readonly file: string;
  readonly hunks: HunkItem[];
  currentHunk: number;
}

/**
 * Robust unified diff hunk parser.
 * Handles single or multiple hunks produced by unifiedDiff or git patch.
 */
export function parseHunksFromDiff(
  diffText: string,
  fallbackFile = "patch",
): { file: string; hunks: HunkItem[] } {
  const lines = diffText.split("\n");
  let file = fallbackFile;
  const hunks: HunkItem[] = [];
  let current: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    header: string;
    heading: string;
    lines: string[];
    staged: boolean;
  } | null = null;

  let hunkIndex = 0;

  for (const line of lines) {
    // File headers come only before the first hunk: inside a hunk, "--- x" is a removed line "-- x".
    if (current === null && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      const match = /^[+-]{3}\s+[ab]\/(.+)$/.exec(line);
      if (match?.[1]) file = match[1];
      continue;
    }

    const hunkMatch = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/.exec(line);
    if (hunkMatch) {
      if (current) {
        hunks.push({
          id: hunkIndex++,
          ...current,
          lines: [...current.lines],
        });
      }
      current = {
        oldStart: Number.parseInt(hunkMatch[1] ?? "1", 10),
        oldLines: Number.parseInt(hunkMatch[2] ?? "1", 10),
        newStart: Number.parseInt(hunkMatch[3] ?? "1", 10),
        newLines: Number.parseInt(hunkMatch[4] ?? "1", 10),
        header: line,
        heading: (hunkMatch[5] ?? "").trim(),
        lines: [],
        staged: true,
      };
      continue;
    }

    if (current) {
      if (
        line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith(" ") ||
        line.startsWith("\\")
      ) {
        current.lines.push(line);
      }
    }
  }

  if (current) {
    hunks.push({
      id: hunkIndex++,
      ...current,
      lines: [...current.lines],
    });
  }

  return { file, hunks };
}

/** Create a new HunkStagingState if diffText contains at least one hunk. */
export function createHunkStaging(
  diffText: string,
  fallbackFile?: string,
): HunkStagingState | undefined {
  const { file, hunks } = parseHunksFromDiff(diffText, fallbackFile);
  if (hunks.length === 0) return undefined;
  return {
    file,
    hunks,
    currentHunk: 0,
  };
}

/** Stage or unstage the current hunk, and advance to next. Returns whether review finished. */
export function stageCurrentHunk(
  state: HunkStagingState,
  staged: boolean,
): { finished: boolean; hasStaged: boolean } {
  const current = state.hunks[state.currentHunk];
  if (current) current.staged = staged;

  const hasStaged = state.hunks.some((h) => h.staged);
  if (state.currentHunk < state.hunks.length - 1) {
    state.currentHunk++;
    return { finished: false, hasStaged };
  }
  return { finished: true, hasStaged };
}

/** Stage all remaining hunks from current to end. */
export function stageAllRemaining(state: HunkStagingState): void {
  for (let i = state.currentHunk; i < state.hunks.length; i++) {
    const h = state.hunks[i];
    if (h) h.staged = true;
  }
}

/** Discard all hunks. */
export function discardAllHunks(state: HunkStagingState): void {
  for (const h of state.hunks) {
    h.staged = false;
  }
}

/** Navigate between hunks. */
export function navigateHunk(state: HunkStagingState, delta: number): void {
  const next = state.currentHunk + delta;
  state.currentHunk = Math.max(0, Math.min(state.hunks.length - 1, next));
}
