import { createTwoFilesPatch } from "diff";

/** Longest preview the user sees. A longer diff is cut, with a note. */
const MAX_PREVIEW_LINES = 400;

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
