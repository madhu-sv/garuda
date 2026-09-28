import { modelFacts, type Runtime } from "../../app/runtime.js";
import { LSP_LANGUAGES } from "../../lsp/servers.js";
import { totalTokens, WEB_SEARCH_USD } from "../../model/pricing.js";
import {
  findReferencesTool,
  findSymbolText,
  findSymbolTool,
  referencesText,
  repoMapText,
  repoMapTool,
} from "../../tools/codeTools.js";
import type { ToolContext } from "../../tools/types.js";
import { colorDiff } from "../approver.js";
import type { Renderer } from "../renderer.js";
import { formatTokens } from "../report.js";
import { modeText } from "./plan.js";

/** Chat commands (F2). The plain chat and the Ink chat share them. */

export const HELP = [
  "Type a task and press Enter. @path attaches a file or folder, !command runs a command, Tab completes.",
  "Commands:",
  "  /help      show this help",
  "  /usage     tokens and cost of this session",
  "  /session   the session id and file",
  "  /sessions  this project's sessions; /sessions <n|id> continues one; rename, delete",
  "  /models    the models; /models <n|id|opus|sonnet|haiku> switches for this chat",
  "  /export    write this conversation as Markdown; /export <file>",
  "  /compact   summarise the older turns now; /compact <what to keep>",
  "  /diff      file changes in this session; /diff last (last turn); /diff [last] <path>",
  "  /schedule  make the last plan a job that runs later: /schedule [HH:MM], then garuda run <id>",
  "  /jobs      the scheduled jobs of this project; /jobs <id> shows one; /jobs cancel <id>",
  "  /where X   where symbol X is defined (code index, no model call)",
  "  /refs X    every use of symbol X (code index, no model call)",
  "  /map [dir] what each JS/TS file exports and imports",
  "  /mcp       MCP servers: state, sandbox, network and tool count; /mcp logout <server>",
  "  /hooks     the active hooks",
  "  /lsp       language servers for diagnostics; /lsp install <typescript|python|java>",
  "  /commands  your custom commands and skills (~/.garuda, .garuda, .claude)",
  "  /agents    your custom agents and their tools (~/.garuda, .garuda, .claude)",
  "  /plan      plan mode: read and plan, change nothing (Shift+Tab toggles); /plan <task> plans it",
  "  /build     build mode: change files and run commands (the default); /build <task> runs it",
  "  /undo      take back the last turn: its file changes and its messages",
  "  /redo      bring back the last undone turn",
  "  /init      set up this folder: AGENTS.md, and files from other agents (Claude Code, OpenCode …)",
  "  /editor    write the next prompt in $VISUAL or $EDITOR (also Ctrl-G)",
  "  /new       start a new session (the old one stays on disk)",
  "  /exit      leave (or press Ctrl-D, or Ctrl-C twice)",
].join("\n");

export interface CommandContext {
  runtime: Runtime;
  renderer: Renderer;
  sessionPath: (id: string) => string;
  /**
   * Text with its own colors (0.6: /diff), and the full text for Ctrl-O when the shown text is cut.
   * Default: renderer.info.
   */
  output?: (text: string, full?: { title: string; text: string }) => void;
  /** Stops a command that calls the model (0.8: /compact). Default: a signal that never fires. */
  signal?: AbortSignal;
}

/**
 * Run a line that starts with "/". A custom command gives back its prompt, for the caller to run
 * as a turn.
 */
export async function runCommand(
  text: string,
  { runtime, renderer, sessionPath, output, signal }: CommandContext,
): Promise<"exit" | "done" | { prompt: string }> {
  const command = text.split(/\s+/)[0];
  if (command === "/exit" || command === "/quit") return "exit";
  if (command === "/help") renderer.info(helpText(runtime));
  else if (command === "/commands") renderer.info(commandsText(runtime));
  else if (command === "/agents") renderer.info(agentsText(runtime));
  else if (command === "/plan" || command === "/build") {
    runtime.setMode(command === "/plan" ? "plan" : "build");
    renderer.info(modeText(runtime));
    // "/plan <task>" (0.8): switch, then run the task in the new mode.
    const task = text.slice(command.length).trim();
    if (task !== "") return { prompt: task };
  } else if (command === "/usage") renderer.info(usageSummary(runtime));
  else if (command === "/session") {
    const id = runtime.session?.id;
    renderer.info(id === undefined ? "No session yet." : `Session ${id}\n${sessionPath(id)}`);
  } else if (command === "/sessions") {
    await sessionsCommand(
      runtime,
      renderer,
      text.slice(command.length).trim(),
      signal ?? new AbortController().signal,
    );
  } else if (command === "/models") {
    const arg = text.slice(command.length).trim();
    if (arg === "") renderer.info(modelsText(runtime));
    else {
      const result = await runtime.setModel(arg);
      if (result.ok) renderer.info(result.text);
      else renderer.warn(result.text);
    }
  } else if (command === "/compact") {
    await compactCommand(
      runtime,
      renderer,
      text.slice(command.length).trim(),
      signal ?? new AbortController().signal,
    );
  } else if (command === "/diff") {
    await diffCommand(runtime, renderer, text.slice(command.length).trim(), output);
  } else if (command === "/schedule") {
    const at = text.slice(command.length).trim();
    const result = await runtime.scheduleJob(
      at === "" ? undefined : at,
      new AbortController().signal,
    );
    if (result.ok) renderer.info(result.text);
    else renderer.warn(result.text);
  } else if (command === "/jobs") {
    await jobsCommand(runtime, renderer, text.slice(command.length).trim());
  } else if (command === "/export") {
    await exportCommand(runtime, renderer, text.slice(command.length).trim());
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
  } else if (command === "/editor") {
    // The Ink chat handles /editor before this; the plain chat has no input line to fill.
    renderer.info("The external editor works in the full chat: Ctrl-G or /editor.");
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

/** /sessions: the list; /sessions <n|id>: continue that session (0.6). */
async function sessionsCommand(
  runtime: Runtime,
  renderer: Renderer,
  arg: string,
  signal: AbortSignal,
): Promise<void> {
  const [verb = "", ref = "", ...rest] = arg.split(/\s+/);
  if (verb === "rename" || verb === "delete") {
    const use = `Use: /sessions ${verb} <number or id>${verb === "rename" ? " <title>" : ""}.`;
    if (
      ref === "" ||
      (verb === "rename" && rest.length === 0) ||
      (verb === "delete" && rest.length > 0)
    ) {
      renderer.warn(use);
      return;
    }
    const result =
      verb === "rename"
        ? await runtime.renameSession(ref, rest.join(" "))
        : await runtime.deleteSession(ref, signal);
    if (result.ok) renderer.info(result.text);
    else renderer.warn(result.text);
    return;
  }
  if (arg !== "") {
    const result = await runtime.switchSession(arg);
    if (result.ok) renderer.info(result.text);
    else renderer.warn(result.text);
    return;
  }
  const { sessions, total } = await runtime.listSessions();
  if (sessions.length === 0) {
    renderer.info("There are no sessions in this project yet.");
    return;
  }
  const open = runtime.session?.id;
  const width = String(sessions.length).length;
  const rows = sessions.flatMap((s, i) => {
    const facts = [
      s.id,
      `${s.turns} turn${s.turns === 1 ? "" : "s"}`,
      ...(s.costUsd === undefined || s.costUsd === 0 ? [] : [`$${s.costUsd.toFixed(2)}`]),
      ...(s.model === undefined ? [] : [s.model]),
    ].join(" · ");
    return [
      `  ${String(i + 1).padStart(width)}. ${localTime(s.updated)}  ${s.title === "" ? "(no prompt)" : s.title}${s.id === open ? "  (open)" : ""}`,
      `  ${"".padStart(width)}  ${facts}`,
    ];
  });
  renderer.info(
    [
      "Sessions in this project, newest first:",
      ...rows,
      ...(total > sessions.length ? [`  … ${total - sessions.length} older`] : []),
      "Continue one with /sessions <number or id>. /new starts a new one.",
      "/sessions rename <number or id> <title> · /sessions delete <number or id>",
    ].join("\n"),
  );
}

/** "2026-09-26 10:15" in local time. */
function localTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** /models: the known and configured models, the current one marked (0.6). */
export function modelsText(runtime: Runtime): string {
  const list = runtime.modelList();
  const width = Math.max(...list.map((m) => m.spec.length));
  const numbers = String(list.length).length;
  return [
    "Models (● the current one):",
    ...list.map((m, i) => {
      const mark = m.spec === runtime.modelId ? "●" : " ";
      return `  ${mark} ${String(i + 1).padStart(numbers)}  ${m.spec.padEnd(width + 2)}${modelFacts(m.info.contextWindow, m.info.price)}`;
    }),
    "Switch with /models <number, id or opus|sonnet|haiku|fable>. It is for this chat only.",
    "Add other models (Ollama, OpenRouter …) in ~/.garuda/models.json.",
  ].join("\n");
}

/** The diff lines /diff shows before it cuts; Ctrl-O shows all. */
export const DIFF_LINES = 300;

/** /diff [last] [path]: the file changes of this session or of the last turn (0.6). */
async function diffCommand(
  runtime: Runtime,
  renderer: Renderer,
  arg: string,
  /** The Ink chat's output (colors, Ctrl-O); the plain chat prints with renderer.info. */
  output: CommandContext["output"],
): Promise<void> {
  const words = arg === "" ? [] : arg.split(/\s+/);
  const scope = words[0] === "last" ? "last" : "session";
  const path = (scope === "last" ? words.slice(1) : words).join(" ");
  const result = await runtime.diff(
    scope,
    path === "" ? undefined : path,
    new AbortController().signal,
  );
  if ("problem" in result) {
    renderer.warn(result.problem);
    return;
  }
  const since =
    scope === "last" ? "since the start of the last turn" : "since the first turn of this session";
  const where = result.path === undefined ? "" : ` in ${result.path}`;
  if (result.files.length === 0) {
    renderer.info(`No file changed${where} ${since}.`);
    return;
  }
  const plus = result.files.reduce((n, f) => n + (f.added ?? 0), 0);
  const minus = result.files.reduce((n, f) => n + (f.removed ?? 0), 0);
  const width = Math.max(...result.files.map((f) => f.path.length));
  const mark = { added: "A", modified: "M", deleted: "D" } as const;
  const rows = result.files.map((f) => {
    const counts =
      f.added === undefined
        ? "binary"
        : [f.added > 0 ? `+${f.added}` : "", f.removed ? `−${f.removed}` : ""]
            .filter(Boolean)
            .join(" ");
    return `  ${mark[f.status]} ${f.path.padEnd(width + 2)}${counts}`;
  });
  const lines = result.patch.replace(/\n$/, "").split("\n");
  const cut = lines.length > DIFF_LINES;
  const more =
    output === undefined
      ? "/diff <path> shows one file."
      : "Ctrl-O shows all; /diff <path> shows one file.";
  (output ?? ((t: string) => renderer.info(t)))(
    [
      `Changes${where} ${since} (${result.files.length} file${result.files.length === 1 ? "" : "s"}, +${plus} −${minus}). Changes you made yourself count too.`,
      ...rows,
      "",
      colorDiff(lines.slice(0, DIFF_LINES).join("\n")),
      ...(cut ? [`… ${lines.length - DIFF_LINES} more lines. ${more}`] : []),
    ].join("\n"),
    cut ? { title: `diff ${since}${where}`, text: colorDiff(result.patch) } : undefined,
  );
}

/** /jobs [id] (0.7): the list, or one job with its report. */
async function jobsCommand(runtime: Runtime, renderer: Renderer, id: string): Promise<void> {
  const { listJobs, loadJob, JOBS_DIR } = await import("../../jobs/job.js");
  const cancel = /^cancel\s+(\S+)$/.exec(id);
  if (cancel !== null) {
    renderer.info(await runtime.cancelJob(cancel[1] as string));
    return;
  }
  if (id !== "") {
    try {
      const job = await loadJob(runtime.root, id);
      const { jobReport } = await import("../../jobs/text.js");
      renderer.info(jobReport(job));
    } catch (error) {
      renderer.warn((error as Error).message);
    }
    return;
  }
  const jobs = await listJobs(runtime.root);
  if (jobs.length === 0) {
    renderer.info("No jobs in this project. Make a plan (/plan), then /schedule.");
    return;
  }
  renderer.info(
    [
      `Jobs (${JOBS_DIR}), newest first:`,
      ...jobs.map((j) => {
        const r = j.result;
        const facts = [
          j.status,
          ...(j.at === undefined || j.status !== "scheduled" ? [] : [`at ${j.at}`]),
          ...(r === undefined ? [] : [`${r.files.length} file(s)`]),
          ...(r?.costUsd === undefined ? [] : [`$${r.costUsd.toFixed(2)}`]),
          ...(r === undefined || r.denied.length === 0 ? [] : [`${r.denied.length} denied`]),
        ].join(" · ");
        return `  ${j.id}  ${j.title}\n    ${facts}`;
      }),
      "Details: /jobs <id>. Run one: garuda run <id> [--at HH:MM].",
    ].join("\n"),
  );
}

/** /export [file]: the conversation as Markdown in the working folder (0.6). */
async function exportCommand(runtime: Runtime, renderer: Renderer, file: string): Promise<void> {
  const records = await runtime.sessionRecords();
  const id = runtime.session?.id;
  if (records === undefined || id === undefined) {
    renderer.info("There is no conversation to export yet.");
    return;
  }
  const { sessionMarkdown, writeExport } = await import("../export.js");
  const result = await writeExport(runtime.root, id, sessionMarkdown(records, id), file);
  if ("problem" in result) renderer.warn(result.problem);
  else
    renderer.info(
      `Wrote the conversation to ${result.path}. Secrets are redacted as in the session file.`,
    );
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
    ...(u.webSearches === undefined
      ? []
      : [
          `  Claude web searches: ${u.webSearches} ($${(u.webSearches * WEB_SEARCH_USD).toFixed(2)})`,
        ]),
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

/** /compact [focus] (0.8). */
async function compactCommand(
  runtime: Runtime,
  renderer: Renderer,
  focus: string,
  signal: AbortSignal,
): Promise<void> {
  if (runtime.session === undefined) {
    renderer.info("No session yet: there is nothing to compact.");
    return;
  }
  let result: Awaited<ReturnType<Runtime["compact"]>>;
  try {
    result = await runtime.compact(focus, signal);
  } catch (error) {
    renderer.warn(
      signal.aborted
        ? "Compaction stopped. The conversation did not change."
        : `Compaction failed, and the conversation did not change: ${(error as Error).message}`,
    );
    return;
  }
  if (result === undefined) {
    renderer.info(
      "Too little to compact: the last 4 steps always stay in full. Auto-compaction still runs when the context gets full.",
    );
    return;
  }
  const cost = result.costUsd === undefined ? "" : ` · $${result.costUsd.toFixed(4)}`;
  renderer.info(
    `Context compacted: ${formatTokens(result.beforeTokens)} → about ${formatTokens(result.afterTokens)} tokens${cost}. The last 4 steps stay in full; /usage shows the session totals.`,
  );
}
