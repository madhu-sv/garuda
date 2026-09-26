import type { Runtime } from "../../app/runtime.js";
import { LSP_LANGUAGES } from "../../lsp/servers.js";
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
import { modeText } from "./plan.js";

/** Chat commands (F2). The plain chat and the Ink chat share them. */

export const HELP = [
  "Type a task and press Enter. Commands:",
  "  /help      show this help",
  "  /usage     tokens and cost of this session",
  "  /session   the session id and file",
  "  /where X   where symbol X is defined (code index, no model call)",
  "  /refs X    every use of symbol X (code index, no model call)",
  "  /map [dir] what each JS/TS file exports and imports",
  "  /mcp       MCP servers: state, sandbox, network and tool count; /mcp logout <server>",
  "  /hooks     the active hooks",
  "  /lsp       language servers for diagnostics; /lsp install <typescript|python|java>",
  "  /commands  your custom commands and skills (~/.garuda, .garuda, .claude)",
  "  /agents    your custom agents and their tools (~/.garuda, .garuda, .claude)",
  "  /plan      plan mode: read and plan, change nothing (Shift+Tab toggles)",
  "  /build     build mode: change files and run commands (the default)",
  "  /undo      take back the last turn: its file changes and its messages",
  "  /redo      bring back the last undone turn",
  "  /init      set up this folder: AGENTS.md, and files from other agents (Claude Code, OpenCode …)",
  "  /new       start a new session (the old one stays on disk)",
  "  /exit      leave (or press Ctrl-D, or Ctrl-C twice)",
].join("\n");

export interface CommandContext {
  runtime: Runtime;
  renderer: Renderer;
  sessionPath: (id: string) => string;
}

/**
 * Run a line that starts with "/". A custom command gives back its prompt, for the caller to run
 * as a turn.
 */
export async function runCommand(
  text: string,
  { runtime, renderer, sessionPath }: CommandContext,
): Promise<"exit" | "done" | { prompt: string }> {
  const command = text.split(/\s+/)[0];
  if (command === "/exit" || command === "/quit") return "exit";
  if (command === "/help") renderer.info(helpText(runtime));
  else if (command === "/commands") renderer.info(commandsText(runtime));
  else if (command === "/agents") renderer.info(agentsText(runtime));
  else if (command === "/plan" || command === "/build") {
    runtime.setMode(command === "/plan" ? "plan" : "build");
    renderer.info(modeText(runtime));
  } else if (command === "/usage") renderer.info(usageSummary(runtime));
  else if (command === "/session") {
    const id = runtime.session?.id;
    renderer.info(id === undefined ? "No session yet." : `Session ${id}\n${sessionPath(id)}`);
  } else if (command === "/where" || command === "/refs" || command === "/map") {
    await lookup(runtime, renderer, command, text.slice(command.length).trim());
  } else if (command === "/hooks") {
    const lines = runtime.hookLines();
    renderer.info(
      lines.length === 0
        ? "No active hooks. They load with the first task. Configure them in ~/.garuda/hooks.json or .garuda/hooks.json."
        : lines.join("\n"),
    );
  } else if (command === "/mcp") {
    const [verb, name] = text.slice(command.length).trim().split(/\s+/);
    if (verb === "logout" && name !== undefined && name !== "") {
      const removed = await runtime.mcpLogout(name);
      renderer.info(
        removed > 0
          ? `Signed out of MCP server "${name}": its tokens are gone. The next session asks you to sign in again.`
          : `There are no tokens for MCP server "${name}".`,
      );
    } else if (verb !== undefined && verb !== "") {
      renderer.warn("Use: /mcp, or /mcp logout <server>.");
    } else {
      renderer.info(mcpSummary(runtime));
    }
  } else if (command === "/lsp") {
    await lspCommand(runtime, renderer, text.slice(command.length).trim());
  } else if (command === "/undo" || command === "/redo") {
    const signal = new AbortController().signal;
    renderer.info(await (command === "/undo" ? runtime.undo(signal) : runtime.redo(signal)));
  } else if (command === "/init") {
    const { report, prompt } = await runtime.init(new AbortController().signal);
    if (report.length > 0) renderer.info(report.join("\n"));
    return { prompt };
  } else if (command === "/new") {
    runtime.newSession();
    renderer.info("The next task starts a new session.");
  } else {
    const resolved = await runtime.resolveCommand(text, new AbortController().signal);
    if (resolved.kind === "prompt") return { prompt: resolved.prompt };
    if (resolved.kind === "denied") renderer.info(resolved.message);
    else renderer.warn(`Unknown command ${command}. Type /help.`);
  }
  return "done";
}

/** /lsp: the status; /lsp install <language>: the managed install (npm, network). */
async function lspCommand(runtime: Runtime, renderer: Renderer, arg: string): Promise<void> {
  if (arg === "") {
    renderer.info(await runtime.lspStatus());
    return;
  }
  const [verb, language] = arg.split(/\s+/);
  const lang = LSP_LANGUAGES.find((l) => l === language);
  if (verb !== "install" || lang === undefined) {
    renderer.warn(`Use: /lsp, or /lsp install <${LSP_LANGUAGES.join("|")}>.`);
    return;
  }
  renderer.info(`Installing the ${lang} language server (download outside the sandbox) …`);
  const result = await runtime.installLsp(lang, new AbortController().signal);
  if (!result.ok) {
    renderer.warn(`The install failed.\n$ ${result.command}\n${result.output ?? ""}`);
    return;
  }
  renderer.info(
    runtime.lspEnabled
      ? `Installed into ${result.dir}. The next edit of a ${lang} file uses it.`
      : `Installed into ${result.dir}. Diagnostics are off: start with --lsp, or set "lsp": { "enabled": true } in .garuda/settings.json.`,
  );
}

/** /help: the built-in commands, then the custom ones and the skills. */
export function helpText(runtime: Runtime): string {
  return runtime.commands.length + runtime.skills.length === 0
    ? HELP
    : `${HELP}\n\n${commandsText(runtime)}`;
}

/** /commands: the custom commands and the skills, with their source and description. */
export function commandsText(runtime: Runtime): string {
  const skills = runtime.skills;
  if (runtime.commands.length + skills.length === 0) {
    return [
      "No custom commands and no skills.",
      "Commands: Markdown files in ~/.garuda/commands/ or .garuda/commands/.",
      "Skills: <name>/SKILL.md folders in ~/.garuda/skills/, .garuda/skills/ (or .claude/skills/).",
    ].join("\n");
  }
  const rows = (
    list: readonly { name: string; argumentHint?: string; about: string; project: boolean }[],
  ) =>
    list.map((c) => ({
      usage: `/${c.name}${c.argumentHint === undefined ? "" : ` ${c.argumentHint}`}`,
      about: `${c.about}${c.project ? " (project)" : ""}`,
    }));
  const commandRows = rows(
    runtime.commands.map((c) => ({
      name: c.name,
      ...(c.argumentHint === undefined ? {} : { argumentHint: c.argumentHint }),
      about: c.description ?? "",
      project: c.source === "project",
    })),
  );
  const skillRows = skills.map((s) => ({
    usage: s.userInvocable
      ? `/${s.name}${s.argumentHint === undefined ? "" : ` ${s.argumentHint}`}`
      : s.name,
    about: `${s.description.length > 80 ? `${s.description.slice(0, 79)}…` : s.description} (${s.shown}${s.modelInvocable ? "" : ", you only"}${s.userInvocable ? "" : ", model only"})`,
  }));
  const width = Math.max(...[...commandRows, ...skillRows].map((r) => r.usage.length));
  const table = (title: string, list: { usage: string; about: string }[]) =>
    list.length === 0
      ? []
      : [title, ...list.map((r) => `  ${r.usage.padEnd(width + 2)}${r.about}`.trimEnd())];
  return [...table("Custom commands:", commandRows), ...table("Skills:", skillRows)].join("\n");
}

/** /agents: the custom agents, with their source, tools and model. */
export function agentsText(runtime: Runtime): string {
  const agents = runtime.agents;
  if (agents.length === 0) {
    return "No custom agents. Add Markdown files to ~/.garuda/agents/ or .garuda/agents/ (or .claude/agents/).";
  }
  const width = Math.max(...agents.map((a) => a.name.length));
  return [
    "Custom agents (the model hands tasks to them with the agent tool):",
    ...agents.map((a) => {
      const about = a.description.length > 80 ? `${a.description.slice(0, 79)}…` : a.description;
      const tools = a.tools === undefined ? "read-only tools" : a.tools.join(", ");
      const model = a.model === undefined ? "" : ` · model ${a.model}`;
      return `  ${a.name.padEnd(width + 2)}${about}\n  ${"".padEnd(width + 2)}${tools}${model} · ${a.shown}`;
    }),
  ].join("\n");
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

function mcpSummary(runtime: Runtime): string {
  const servers = runtime.mcpStatus();
  if (servers.length === 0) {
    return "No MCP servers are running. They start with the first task. Configure them in ~/.garuda/mcp.json or .garuda/mcp.json.";
  }
  return servers
    .map((s) => {
      const note = s.message === undefined ? "" : ` (${s.message})`;
      if (s.transport === "http") {
        const auth = s.signedIn ? "signed in" : "no sign-in";
        return `${s.name} [${s.source}] ${s.state}${note} · ${s.tools} tool(s) · remote ${s.url ?? ""} · ${auth}`;
      }
      const box = s.sandboxed ? "sandbox" : "NO sandbox";
      const net = s.network ? "network" : "no network";
      return `${s.name} [${s.source}] ${s.state}${note} · ${s.tools} tool(s) · ${box} · ${net}`;
    })
    .join("\n");
}
