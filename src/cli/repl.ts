import { createInterface } from "node:readline";
import type { Runtime } from "../app/runtime.js";
import type { Approver } from "../permissions/types.js";
import { runCommand } from "./chat/commands.js";
import { complete, rootLister } from "./chat/complete.js";
import { CommandArgs, commandNames } from "./chat/controller.js";
import { BUILD_PROMPT, planHandoff } from "./chat/plan.js";
import type { Notifier } from "./notify.js";
import type { Renderer } from "./renderer.js";
import type { Interruptible } from "./turn.js";
import { runTurnInTerminal } from "./turn.js";

/**
 * Interactive mode (F2): a chat prompt. Each line is one turn.
 * Ctrl-C at the prompt twice (within 2 s) or Ctrl-D exits. Ctrl-C during a turn stops the turn.
 */

export { HELP } from "./chat/commands.js";

export interface ReplIO {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
}

type Input = { kind: "line"; text: string } | { kind: "eof" } | { kind: "interrupt" };

export async function runRepl(
  runtime: Runtime,
  approver: Interruptible & Approver,
  renderer: Renderer,
  sessionPath: (id: string) => string,
  exitNow: () => never,
  io: ReplIO = { input: process.stdin, output: process.stderr },
  /** A first line to run, as if typed (garuda init runs "/init"). */
  firstInput?: string,
  /** Tells the user when a long turn ends (0.6). */
  notifier?: Notifier,
): Promise<void> {
  const history: string[] = [];
  // Tab completion (0.6): the same /commands and @paths as the Ink chat.
  const list = rootLister(runtime.root);
  const args = new CommandArgs(runtime);
  const completer = (line: string): [string[], string] => {
    const result = complete(line, line.length, {
      commands: commandNames(runtime),
      list,
      args: (command, before) => args.choices(command, before),
    });
    if (result === undefined) return [[], line];
    const word = line.slice(line.search(/\S*$/));
    const done = result.text.slice(line.search(/\S*$/));
    // Readline lists the words itself: no hints (0.8) in them.
    const words = result.candidates.map((c) =>
      result.lines === true ? (c.split("  ")[0] ?? c) : c,
    );
    return [words.length > 0 ? words : [done], word];
  };
  const ask = lineSource(io, completer);
  let lastInterrupt = 0;
  let first = firstInput;

  for (;;) {
    void args.refresh();
    const input: Input =
      first !== undefined
        ? { kind: "line", text: first }
        : await ask(runtime.mode === "plan" ? "plan› " : "› ", history);
    first = undefined;
    if (input.kind === "eof") return;
    if (input.kind === "interrupt") {
      if (Date.now() - lastInterrupt < 2_000) return;
      lastInterrupt = Date.now();
      renderer.info("Press Ctrl-C again to exit, or type /exit.");
      continue;
    }

    // A line that ends with a backslash goes on on the next line (0.6), as in a shell.
    let raw = input.text;
    while (raw.endsWith("\\")) {
      const more = await ask("… ", []);
      if (more.kind !== "line") break;
      raw = `${raw.slice(0, -1)}\n${more.text}`;
    }
    const text = raw.trim();
    if (text === "") continue;
    history.unshift(raw);

    // !command (0.6): run it like the bash tool; the output also goes with the next message.
    if (text.startsWith("!") && text.length > 1) {
      const controller = new AbortController();
      approver.onInterrupt = () => controller.abort();
      try {
        const result = await runtime.runUserCommand(text.slice(1).trim(), controller.signal);
        renderer.info(`${result.text}\n(The output goes to the model with your next message.)`);
      } catch (error) {
        renderer.warn(controller.signal.aborted ? "Command stopped." : (error as Error).message);
      } finally {
        approver.onInterrupt = () => {};
      }
      continue;
    }

    let prompt = text;
    if (text.startsWith("/")) {
      const result = await runCommand(text, { runtime, renderer, sessionPath });
      if (result === "exit") return;
      if (result === "done") continue;
      prompt = result.prompt;
    }

    for (;;) {
      const planning = runtime.mode === "plan";
      const outcome = await runTurnInTerminal(
        runtime,
        approver,
        renderer,
        prompt,
        exitNow,
        notifier,
      );
      // A finished plan: ask whether to build it.
      if (!planning || outcome.kind !== "done" || outcome.result.stopReason !== "done") break;
      if ((await planHandoff(runtime, approver)) !== "now") break;
      renderer.info(`› ${BUILD_PROMPT}`);
      prompt = BUILD_PROMPT;
    }
  }
}

/**
 * Read one line.
 * On a terminal: a new readline interface for each line, closed after it, so the approval
 * prompt (inquirer) has the terminal to itself during a turn.
 * On a pipe: one interface for the whole chat, with a queue, so no buffered line is lost.
 */
function lineSource(
  io: ReplIO,
  completer?: (line: string) => [string[], string],
): (prompt: string, history: string[]) => Promise<Input> {
  if (io.input.isTTY === true) {
    return (prompt, history) => askTerminal(prompt, history, io, completer);
  }

  const rl = createInterface({ input: io.input, terminal: false });
  const queue: Input[] = [];
  let waiting: ((input: Input) => void) | undefined;
  const push = (input: Input) => {
    if (waiting !== undefined) {
      const resolve = waiting;
      waiting = undefined;
      resolve(input);
    } else queue.push(input);
  };
  rl.on("line", (text) => push({ kind: "line", text }));
  rl.on("close", () => push({ kind: "eof" }));
  return (prompt) => {
    io.output.write(prompt);
    const next = queue.shift();
    if (next !== undefined) {
      if (next.kind === "eof") queue.unshift(next);
      return Promise.resolve(next);
    }
    return new Promise((resolve) => {
      waiting = resolve;
    });
  };
}

function askTerminal(
  prompt: string,
  history: string[],
  io: ReplIO,
  completer?: (line: string) => [string[], string],
): Promise<Input> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: io.input,
      output: io.output,
      terminal: true,
      history: [...history],
      historySize: 100,
      ...(completer === undefined ? {} : { completer }),
    });
    let done = false;
    const finish = (input: Input) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(input);
    };
    rl.on("line", (text) => finish({ kind: "line", text }));
    rl.on("SIGINT", () => {
      io.output.write("\n");
      finish({ kind: "interrupt" });
    });
    rl.on("close", () => finish({ kind: "eof" }));
    rl.setPrompt(prompt);
    rl.prompt();
  });
}
