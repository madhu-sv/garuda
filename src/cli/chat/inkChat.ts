import { render } from "ink";
import { createElement } from "react";
import type { Runtime } from "../../app/runtime.js";
import type { SwitchApprover } from "../approver.js";
import { FOCUS_REPORTING_OFF, FOCUS_REPORTING_ON, type FocusTracker } from "../focus.js";
import type { Notifier } from "../notify.js";
import type { Renderer } from "../renderer.js";
import { runChat, statusOf } from "./controller.js";
import { editInEditor } from "./externalEditor.js";
import { ChatStore } from "./store.js";
import { App } from "./ui.js";

/**
 * A clear screen that keeps what was there (0.18.1): new lines push the old screen up into the
 * scrollback, as `clear` does in most terminals, then the cursor goes to the top. ESC[2J alone
 * drops the old screen in some terminals.
 */
export function clearScreenKeepingScrollback(rows: number): string {
  return `${"\n".repeat(Math.max(1, rows))}\u001b[H`;
}

/**
 * The Ink chat (0.2). The CLI loads this module with import() only for a chat on a
 * terminal, so Ink and React never slow down -p, pipes or evals (N3).
 */
export async function runInkChat(
  runtime: Runtime,
  approver: SwitchApprover,
  /** Sends the runtime's agent events to the chat view. */
  setEventTarget: (renderer: Renderer) => void,
  banner: string,
  sessionPath: (id: string) => string,
  exitNow: () => never,
  /** A first line to run, as if typed (garuda init runs "/init"). */
  firstInput?: string,
  notifier?: Notifier,
  /** Focus reporting (0.6): the chat turns it on and feeds the tracker. */
  focus?: FocusTracker,
  /** UX U10: the footer shows the key hints (the first chats). */
  keyHints = true,
  /** 0.18.1: start on a clear screen ("ui": { "clearOnStart": false } turns it off). */
  clearOnStart = true,
): Promise<void> {
  if (clearOnStart && process.stdout.isTTY === true) {
    process.stdout.write(clearScreenKeepingScrollback(process.stdout.rows || 24));
  }
  const store = new ChatStore(statusOf(runtime), { keyHints });
  store.print(banner);
  if (firstInput !== undefined) store.enqueue(firstInput);
  approver.current = store;
  setEventTarget(store);
  const ink = render(createElement(App, { store }), { exitOnCtrlC: false });
  const reportFocus = (on: boolean) => {
    if (focus !== undefined) process.stdout.write(on ? FOCUS_REPORTING_ON : FOCUS_REPORTING_OFF);
  };
  if (focus !== undefined) store.onFocus = (focused) => focus.update(focused);
  reportFocus(true);
  // Ctrl-G and /editor (0.6): give the terminal to the editor, then take it back.
  store.externalEdit = (text) => {
    const stdin = process.stdin;
    const raw = stdin.isTTY === true && stdin.isRaw;
    if (raw) stdin.setRawMode(false);
    stdin.pause();
    // The editor gets the terminal: no focus codes into it. Garuda's window has focus after it.
    reportFocus(false);
    try {
      return editInEditor(text);
    } finally {
      if (raw) stdin.setRawMode(true);
      stdin.resume();
      focus?.update(true);
      reportFocus(true);
      ink.clear();
    }
  };
  const exitClean = (): never => {
    ink.unmount();
    return exitNow();
  };
  try {
    await runChat(runtime, store, sessionPath, exitClean, notifier);
  } finally {
    reportFocus(false);
    ink.unmount();
  }
}
