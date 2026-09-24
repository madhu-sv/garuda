import type { Runtime } from "../../app/runtime.js";
import { totalTokens } from "../../model/pricing.js";
import {
  findReferencesTool,
  findSymbolText,
  findSymbolTool,
  referencesText,
  repoMapText,
  repoMapTool,
} from "../../tools/codeTools.js";
import type { ToolContext } from "../../tools/types.js";
import type { Renderer } from "../renderer.js";
import { formatTokens } from "../report.js";

/** Chat commands (F2). The plain chat and the Ink chat share them. */

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

export interface CommandContext {
  runtime: Runtime;
  renderer: Renderer;
  sessionPath: (id: string) => string;
}

/** Run a line that starts with "/". */
export async function runCommand(
  text: string,
  { runtime, renderer, sessionPath }: CommandContext,
): Promise<"exit" | "done"> {
  const command = text.split(/\s+/)[0];
  if (command === "/exit" || command === "/quit") return "exit";
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
  return "done";
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

export function usageSummary(runtime: Runtime): string {
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
