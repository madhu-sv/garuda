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
 * The focus state in a chunk of raw terminal input, or undefined when it holds no focus event. The
 * terminal sends ESC [ I (focus in) and ESC [ O (focus out). The last one in the chunk wins.
 *
 * Since ink 8 the chat reads focus from stdin directly (`watchFocus`), not from `useInput`: ink 8
 * parses and swallows the focus sequences, so they never reach a key handler.
 */
export function focusEvent(chunk: string): boolean | undefined {
  const csi = "\x1b[";
  let state: boolean | undefined;
  for (let i = chunk.indexOf(csi); i !== -1; i = chunk.indexOf(csi, i + 2)) {
    const after = chunk[i + 2];
    if (after === "I") state = true;
    else if (after === "O") state = false;
  }
  return state;
}

/** A minimal stdin, as both the real one and ink's test stdin satisfy. */
interface DataStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

/**
 * Watch stdin for terminal focus events, beside ink. A `data` listener sees every chunk, including
 * the focus sequences that ink 8 consumes before `useInput`. It only reads; it never takes input
 * from ink. Returns a function that detaches the listener.
 */
export function watchFocus(stdin: DataStream, onFocus: (focused: boolean) => void): () => void {
  const onData = (chunk: Buffer | string) => {
    const focused = focusEvent(typeof chunk === "string" ? chunk : chunk.toString("latin1"));
    if (focused !== undefined) onFocus(focused);
  };
  stdin.on("data", onData);
  return () => {
    stdin.off("data", onData);
  };
}
