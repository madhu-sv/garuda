import type { Settings } from "../permissions/settings.js";
import { screenReaderMode } from "./receiptView.js";

/**
 * The marks of the chat and of `-p` (UX U12). A screen reader reads "●" and "⎿" as symbol names
 * or not at all, so screen-reader mode (GARUDA_SCREEN_READER=1) uses words.
 */
export interface Marks {
  /** Before a tool call. */
  call: string;
  /** Before its result. */
  result: string;
  /** Before an answered question. */
  allowed: string;
  denied: string;
  /** Before the selected and the other choices of a question or the palette. */
  selected: string;
  unselected: string;
  /** Plan steps: done, current, open. */
  done: string;
  now: string;
  open: string;
}

const SYMBOLS: Marks = {
  call: "●",
  result: "⎿",
  allowed: "✔",
  denied: "✗",
  selected: "❯ ",
  unselected: "  ",
  done: "✔",
  now: "▶",
  open: "○",
};

const WORDS: Marks = {
  call: "Tool:",
  result: "Result:",
  allowed: "Allowed:",
  denied: "Denied:",
  selected: "(selected) ",
  unselected: "",
  done: "Done:",
  now: "Now:",
  open: "To do:",
};

export function marks(screenReader: boolean = screenReaderMode()): Marks {
  return screenReader ? WORDS : SYMBOLS;
}

/**
 * Reduced motion (UX U12): GARUDA_MOTION=reduce or `"ui": { "motion": "reduce" }`. No spinner
 * frames; the live line counts seconds instead. Screen-reader mode implies it: a screen reader
 * reads a changed line again, ten times a second for a spinner.
 */
export function motionReduced(
  env: NodeJS.ProcessEnv = process.env,
  ui: Settings["ui"] = undefined,
): boolean {
  return env.GARUDA_MOTION === "reduce" || ui?.motion === "reduce" || screenReaderMode(env);
}
