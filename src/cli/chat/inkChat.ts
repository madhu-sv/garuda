import { render } from "ink";
import { createElement } from "react";
import type { Runtime } from "../../app/runtime.js";
import type { SwitchApprover } from "../approver.js";
import type { Renderer } from "../renderer.js";
import { runChat, statusOf } from "./controller.js";
import { ChatStore } from "./store.js";
import { App } from "./ui.js";

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
): Promise<void> {
  const store = new ChatStore(statusOf(runtime));
  store.info(banner);
  approver.current = store;
  setEventTarget(store);
  const ink = render(createElement(App, { store }), { exitOnCtrlC: false });
  const exitClean = (): never => {
    ink.unmount();
    return exitNow();
  };
  try {
    await runChat(runtime, store, sessionPath, exitClean);
  } finally {
    ink.unmount();
  }
}
