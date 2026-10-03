import { cleanText } from "../mcp/sanitize.js";
import type { ApprovalRequest } from "../permissions/types.js";
import type { Isolation } from "../sandbox/types.js";
import type { FileChange } from "./snapshots.js";

/** Most file lines in the /undo and /redo question. */
export const MAX_CHANGE_LINES = 30;

const MARKS: Readonly<Record<FileChange["status"], string>> = {
  added: "+",
  deleted: "-",
  modified: "~",
};

/**
 * The question before /undo or /redo (0.4): the turn, the files that change (from the state now
 * to the snapshot), and what happens to the conversation. It can overwrite changes that the user
 * made after the turn, so it always asks.
 */
export function undoQuestion(
  kind: "undo" | "redo",
  prompt: string,
  changes: readonly FileChange[],
  conversation: boolean,
  isolation: Isolation,
): ApprovalRequest {
  const lines = [`Turn: "${prompt}"`];
  if (changes.length === 0) {
    lines.push("No file changes.");
  } else {
    lines.push(`Files (${changes.length}):`);
    for (const c of changes.slice(0, MAX_CHANGE_LINES))
      lines.push(`  ${MARKS[c.status]} ${cleanText(c.path).replace(/\n/g, " ")}`);
    if (changes.length > MAX_CHANGE_LINES) {
      lines.push(`  … and ${changes.length - MAX_CHANGE_LINES} more.`);
    }
    lines.push("  (+ comes back, - is removed, ~ changes)");
  }
  // Undo covers the files that git sees; a turn may also have changed ignored ones (0.14.1, review:
  // "No file changes" read as if nothing had changed).
  lines.push("Files that .gitignore covers (for example build output) are not in undo.");
  if (kind === "undo") {
    lines.push(
      conversation
        ? "The conversation goes back too: the model forgets this turn."
        : "The conversation was compacted, so it keeps the turn; the model gets a note.",
      "Changes that you made to these files after the turn go back too. /redo brings everything back.",
    );
  } else {
    lines.push(
      conversation
        ? "The turn comes back into the conversation."
        : "The model gets a note that the turn is back.",
      "Changes that you made to these files after the undo are replaced.",
    );
  }
  return {
    tool: kind,
    target: { kind: "input", json: "{}" },
    preview: lines.join("\n"),
    isolation,
    title: kind === "undo" ? "Undo the last turn?" : "Redo the last undone turn?",
    question: kind === "undo" ? "Undo it?" : "Redo it?",
    choices: ["once", "deny"],
    labels: {
      once: kind === "undo" ? "Yes, undo it" : "Yes, redo it",
      deny: "No",
    },
  };
}

/** "3 files changed" / "no file changes". */
export function filesText(changes: readonly FileChange[]): string {
  if (changes.length === 0) return "no file changes";
  return `${changes.length} file${changes.length === 1 ? "" : "s"} changed`;
}
