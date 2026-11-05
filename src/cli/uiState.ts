import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Small facts about the chat UI (UX U10): how many chats this user started, so the footer shows
 * its key hints only for the first ones. ~/.garuda/ui.json; a missing or broken file counts as 0.
 */

/** The footer shows the key hints in the first chats; after that, `?` shows them (decision D9). */
export const KEY_HINT_CHATS = 5;

/** Count one more chat and return the new count. A failed write still returns the count. */
export async function countChat(home: string): Promise<number> {
  const dir = join(home, ".garuda");
  const file = join(dir, "ui.json");
  let chats = 0;
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as { chats?: unknown };
    if (typeof data.chats === "number" && Number.isInteger(data.chats) && data.chats >= 0) {
      chats = data.chats;
    }
  } catch {
    // No file yet, or a broken one: start at 0.
  }
  chats++;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify({ chats })}\n`, { mode: 0o600 });
  } catch {
    // The hints are a help: a home folder that cannot be written changes nothing else.
  }
  return chats;
}

/** Every key of the chat, for `?` on an empty input line (UX U10). */
export const KEYS_HELP = [
  "Keys:",
  "  Enter sends · \\ then Enter, or Alt+Enter: a new line · ↑↓ earlier inputs",
  "  Tab completes /commands and @paths · Shift+Tab plan mode · Ctrl-P commands",
  "  Ctrl-G edits the prompt in your editor · Ctrl-O shows the last output in full",
  "  Esc or Ctrl-C stops a turn · Ctrl-C clears the line · Ctrl-D exits",
  "  !command runs a command yourself · @path attaches a file",
].join("\n");

/** "▓▓▓▓▓▓░░░░" for a percentage, 10 cells. */
export function contextBar(percent: number): string {
  const full = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return `${"▓".repeat(full)}${"░".repeat(10 - full)}`;
}

/** The bar's color: yellow from 70%, red from 80%, where compaction starts. */
export function contextLevel(percent: number): "ok" | "high" | "full" {
  return percent >= 80 ? "full" : percent >= 70 ? "high" : "ok";
}
