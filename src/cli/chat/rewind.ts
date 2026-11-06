import type { UndoPoint } from "../../session/undo.js";
import { formatUsd } from "../report.js";

/** How long ago: "<1 min", "4 min", "2 h", "3 d". */
export function ago(at: number | undefined, now: number): string {
  if (at === undefined) return "";
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/**
 * The /rewind list (UX U6): the session's turns that undo can reach, newest first, with the files
 * each changed, its cost and its age. A turn before a compaction can rewind its files, but not fork.
 */
export function rewindList(points: readonly UndoPoint[], now = Date.now()): string {
  if (points.length === 0) return "There is no turn to rewind to yet.";
  const width = Math.min(40, Math.max(...points.map((p) => p.prompt.length + 2)));
  const rows = points
    .map((p, i) => {
      const prompt = `"${p.prompt}"`;
      const shown = prompt.length > width ? `${prompt.slice(0, width - 2)}…"` : prompt;
      const files =
        p.changedFiles === undefined
          ? ""
          : p.changedFiles === 0
            ? "no files"
            : `${p.changedFiles} file${p.changedFiles === 1 ? "" : "s"}`;
      const cost = p.costUsd === undefined ? "" : formatUsd(p.costUsd);
      const note = p.conversation ? "" : "  (before a compaction: files only)";
      return `  ${String(i + 1).padStart(3)}  ${shown.padEnd(width)}  ${files.padEnd(8)}  ${cost.padEnd(8)}  ${ago(p.at, now)}${note}`.trimEnd();
    })
    .reverse();
  return [
    "Rewind to the start of a turn (newest first):",
    ...rows,
    "/rewind <n> goes back to the start of turn n (/redo brings the turns back).",
    "/rewind fork <n> starts a new session from there; this one stays as it is.",
  ].join("\n");
}
