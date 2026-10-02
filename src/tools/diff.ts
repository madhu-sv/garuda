import { applyPatch, createTwoFilesPatch, structuredPatch } from "diff";

/** Longest preview the user sees. A longer diff is cut, with a note. */
const MAX_PREVIEW_LINES = 400;

/** True when unifiedDiff did not cut the diff (every hunk is in the preview). */
export function previewIsComplete(preview: string): boolean {
  return !/\n… \[\d+ more diff lines\]$/.test(preview);
}

/**
 * Apply only some hunks of the change from `before` to `after` (U0: partial approval). The hunks
 * are those of unifiedDiff (3 lines of context), 0-based, in order. Throws when an index does not
 * exist or the hunks do not apply.
 */
export function applyHunks(before: string, after: string, accepted: readonly number[]): string {
  const patch = structuredPatch("a", "b", before, after, undefined, undefined, { context: 3 });
  const wanted = new Set(accepted);
  for (const i of wanted) {
    if (!Number.isInteger(i) || i < 0 || i >= patch.hunks.length) {
      throw new Error(`There is no hunk ${i + 1} in this change (it has ${patch.hunks.length}).`);
    }
  }
  const result = applyPatch(before, {
    ...patch,
    hunks: patch.hunks.filter((_, i) => wanted.has(i)),
  });
  if (result === false) throw new Error("The accepted hunks do not apply to the file.");
  return result;
}

/** A unified diff for the approval preview (F18). An empty `before` means a new file. */
export function unifiedDiff(path: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(
    before === "" ? "/dev/null" : `a/${path}`,
    `b/${path}`,
    before,
    after,
    undefined,
    undefined,
    { context: 3 },
  );
  const lines = patch.split("\n").filter((line) => !line.startsWith("====="));
  while (lines.at(-1) === "") lines.pop();
  if (lines.length <= MAX_PREVIEW_LINES) return lines.join("\n");
  const cut = lines.length - MAX_PREVIEW_LINES;
  return `${lines.slice(0, MAX_PREVIEW_LINES).join("\n")}\n… [${cut} more diff lines]`;
}
