import type { Runtime } from "../app/runtime.js";
import type { AgentResult } from "../loop/runAgent.js";
import { describeError } from "./errors.js";
import type { Renderer } from "./renderer.js";
import { stopMessage, usageLine } from "./report.js";

/** Something that can stop the turn on Ctrl-C: the terminal approver. */
export interface Interruptible {
  onInterrupt: () => void;
}

export type TurnOutcome =
  | { kind: "done"; result: AgentResult }
  | { kind: "interrupted" }
  | { kind: "error"; message: string };

/**
 * Run one turn with Ctrl-C handling (F4):
 * the first Ctrl-C stops the turn (running commands are killed), a second one exits Garuda.
 * After the turn, print the usage line (F22) and the stop reason (F6, F7).
 */
export async function runTurnInTerminal(
  runtime: Runtime,
  approver: Interruptible,
  renderer: Renderer,
  prompt: string,
  exitNow: () => never,
  /** Told when the turn starts and ends: the chat's notifier (0.6). */
  watcher?: TurnWatcher,
): Promise<TurnOutcome> {
  const started = performance.now();
  watcher?.turnStarted();
  let outcome: TurnOutcome | undefined;
  try {
    outcome = await runTurn(runtime, approver, renderer, prompt, exitNow);
    return outcome;
  } finally {
    watcher?.turnEnded(outcome, performance.now() - started);
  }
}

export interface TurnWatcher {
  turnStarted(): void;
  /** `outcome` is undefined when the turn threw (for example, Garuda exits). */
  turnEnded(outcome: TurnOutcome | undefined, ms: number): void;
}

async function runTurn(
  runtime: Runtime,
  approver: Interruptible,
  renderer: Renderer,
  prompt: string,
  exitNow: () => never,
): Promise<TurnOutcome> {
  const controller = new AbortController();
  const stop = () => {
    if (controller.signal.aborted) exitNow();
    renderer.warn("\nStopping… (press Ctrl-C again to exit Garuda)");
    controller.abort();
  };
  process.on("SIGINT", stop);
  approver.onInterrupt = stop;

  const costBefore = runtime.session?.costUsd ?? 0;
  try {
    const result = await runtime.runTurn(prompt, controller.signal);
    const session = runtime.session;
    if (session !== undefined) {
      const runCost = session.costUsd === undefined ? undefined : session.costUsd - costBefore;
      renderer.info(`\n[${usageLine(result, session, runCost, runtime.limits.contextWindow)}]`);
    }
    const message = stopMessage(result.stopReason, runtime.limits);
    if (message !== undefined) renderer.warn(message);
    return { kind: "done", result };
  } catch (error) {
    if (controller.signal.aborted) {
      runtime.recordStop("interrupted");
      renderer.warn("Turn stopped.");
      return { kind: "interrupted" };
    }
    runtime.recordStop("error");
    const message = describeError(error);
    renderer.error(`Error: ${message}`);
    return { kind: "error", message };
  } finally {
    process.off("SIGINT", stop);
    approver.onInterrupt = () => {};
  }
}
