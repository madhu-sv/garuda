import { createInterface } from "node:readline";
import type { Runtime } from "../app/runtime.js";
import { totalTokens } from "../model/pricing.js";
import {
  findReferencesTool,
  findSymbolText,
  findSymbolTool,
  referencesText,
  repoMapText,
  repoMapTool,
} from "../tools/codeTools.js";
import type { ToolContext } from "../tools/types.js";
import type { Renderer } from "./renderer.js";
import { formatTokens } from "./report.js";
import type { Interruptible } from "./turn.js";
import { runTurnInTerminal } from "./turn.js";

/**
 * Interactive mode (F2): a chat prompt. Each line is one turn.
 * Ctrl-C at the prompt twice (within 2 s) or Ctrl-D exits. Ctrl-C during a turn stops the turn.
 */

export const HELP = [
  "Type a task and press Enter. Commands:",
  "  /help      show this help",
  "  /usage     tokens and cost of this session",
  "  /session   the session id and file",
  "  /where X   where symbol X is defined (code index, no model call)",
  "  /refs X    every use of symbol X (code index, no model call)",
  "  /map [dir] what each JS/TS file exports and imports",
  "  /new       start a new session (the old one stays on disk)",
  "  /exit      leave (or press Ctrl-D, or Ctrl-C twice)",
].join("\n");

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

    if (text.startsWith("/")) {
      const command = text.split(/\s+/)[0];
      if (command === "/exit" || command === "/quit") return;
      if (command === "/help") renderer.info(HELP);
      else if (command === "/usage") renderer.info(usageSummary(runtime));
      else if (command === "/session") {
        const id = runtime.session?.id;
        renderer.info(id === undefined ? "No session yet." : `Session ${id}\n${sessionPath(id)}`);
      } else if (command === "/where" || command === "/refs" || command === "/map") {
        await lookup(runtime, renderer, command, text.slice(command.length).trim());
      } else if (command === "/new") {
        runtime.newSession();
        renderer.info("The next task starts a new session.");
      } else renderer.warn(`Unknown command ${command}. Type /help.`);
      continue;
    }

    await runTurnInTerminal(runtime, approver, renderer, text, exitNow);
  }
}

/** Answer a code question from the local index, with no model call. */
async function lookup(
  runtime: Runtime,
  renderer: Renderer,
  command: string,
  arg: string,
): Promise<void> {
  if (command !== "/map" && arg === "") {
    renderer.warn(`Usage: ${command} <symbol name>`);
    return;
  }
  // The code tools need only the index from the context.
  const context = { knowledge: runtime.knowledge } as ToolContext;
  try {
    let text: string;
    if (command === "/where") {
      text = findSymbolText(await findSymbolTool.run({ name: arg, exact: true }, context));
    } else if (command === "/refs") {
      text = referencesText(await findReferencesTool.run({ name: arg }, context));
    } else {
      text = repoMapText(await repoMapTool.run({ path: arg }, context));
    }
    renderer.info(text);
  } catch (error) {
    renderer.error((error as Error).message);
  }
}

function usageSummary(runtime: Runtime): string {
  const session = runtime.session;
  if (session === undefined) return "No session yet.";
  const u = session.usage;
  const cost = session.costUsd === undefined ? "cost unknown" : `$${session.costUsd.toFixed(4)}`;
  return [
    `Session ${session.id}: ${formatTokens(totalTokens(u))} tokens, ${cost}`,
    `  input ${formatTokens(u.inputTokens)}, cache read ${formatTokens(u.cacheReadTokens)}, cache write ${formatTokens(u.cacheWriteTokens)}, output ${formatTokens(u.outputTokens)}`,
    `  context ${formatTokens(session.contextTokens)} of ${formatTokens(runtime.limits.contextWindow)}`,
  ].join("\n");
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
