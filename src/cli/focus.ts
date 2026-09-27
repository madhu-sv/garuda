/**
 * Terminal focus (0.6): whether the user looks at Garuda's window, so notifications go out only
 * when the window is in the background. The chat turns on focus reporting (DEC mode 1004); the
 * terminal then sends ESC [ I when the window gets focus and ESC [ O when it loses it.
 *
 * Only the Ink chat uses it: it reads the keyboard all the time, also during a task. The plain chat
 * reads only at its prompt, so it would see a focus change too late; it notifies as before.
 */

export const FOCUS_REPORTING_ON = "\x1b[?1004h";
export const FOCUS_REPORTING_OFF = "\x1b[?1004l";

/** Terminals that send focus events. In others the state stays unknown, and every notification goes. */
const REPORTING_TERMINALS = new Set(["iTerm.app", "ghostty", "WezTerm", "vscode"]);

export function reportsFocus(env: NodeJS.ProcessEnv = process.env): boolean {
  // tmux and screen pass focus events only with extra setup: treat the state as unknown there.
  const multiplexer = env.TMUX !== undefined || (env.TERM ?? "").startsWith("screen");
  return !multiplexer && REPORTING_TERMINALS.has(env.TERM_PROGRAM ?? "");
}

/**
 * The focus state. It starts as focused: the user just started Garuda in this window. `undefined`
 * would mean "not known".
 */
export class FocusTracker {
  focused: boolean | undefined = true;

  update(focused: boolean): void {
    this.focused = focused;
  }
}

/**
 * A focus event from the keyboard input, or undefined for other input. Ink gives the sequence
 * without its ESC ("[I", "[O") as one input event of its own.
 */
export function focusEvent(input: string): boolean | undefined {
  const code = input.startsWith("\x1b") ? input.slice(1) : input;
  if (code === "[I") return true;
  if (code === "[O") return false;
  return undefined;
}
