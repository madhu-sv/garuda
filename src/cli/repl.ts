import { createInterface } from "node:readline";
import type { Runtime } from "../app/runtime.js";
import { runCommand } from "./chat/commands.js";
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
  approver: Interruptible,
  renderer: Renderer,
  sessionPath: (id: string) => string,
  exitNow: () => never,
  io: ReplIO = { input: process.stdin, output: process.stderr },
): Promise<void> {
  const history: string[] = [];
  const ask = lineSource(io);
  let lastInterrupt = 0;

  for (;;) {
    const input = await ask("› ", history);
    if (input.kind === "eof") return;
    if (input.kind === "interrupt") {
      if (Date.now() - lastInterrupt < 2_000) return;
      lastInterrupt = Date.now();
      renderer.info("Press Ctrl-C again to exit, or type /exit.");
      continue;
    }

    const text = input.text.trim();
    if (text === "") continue;
    history.unshift(input.text);

    let prompt = text;
    if (text.startsWith("/")) {
      const result = await runCommand(text, { runtime, renderer, sessionPath });
      if (result === "exit") return;
      if (result === "done") continue;
      prompt = result.prompt;
    }

    await runTurnInTerminal(runtime, approver, renderer, prompt, exitNow);
  }
}

/**
 * Read one line.
 * On a terminal: a new readline interface for each line, closed after it, so the approval
 * prompt (inquirer) has the terminal to itself during a turn.
 * On a pipe: one interface for the whole chat, with a queue, so no buffered line is lost.
 */
function lineSource(io: ReplIO): (prompt: string, history: string[]) => Promise<Input> {
  if (io.input.isTTY === true) return (prompt, history) => askTerminal(prompt, history, io);

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

function askTerminal(prompt: string, history: string[], io: ReplIO): Promise<Input> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: io.input,
      output: io.output,
      terminal: true,
      history: [...history],
      historySize: 100,
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
