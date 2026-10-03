import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanText, neutralizeTags } from "../mcp/sanitize.js";
import type { ApprovalRequest } from "../permissions/types.js";
import { parseFrontmatterBlock } from "../skills/frontmatter.js";

/**
 * Custom agents (0.5): Markdown files in Claude Code's subagent format. The frontmatter gives the
 * name, the description (when to use it), the tools and the model; the body is the agent's
 * system prompt. Garuda reads them where they are:
 *
 *   ~/.garuda/agents/<name>.md   user agents (trusted)
 *   ~/.claude/agents/<name>.md   user agents of Claude Code (trusted)
 *   <root>/.garuda/agents/       project agents (ask at first use)
 *   <root>/.claude/agents/       project agents of Claude Code (ask at first use)
 *
 * On a name clash the first one in this list wins. Claude Code lets a project agent win over a
 * user agent; Garuda does not, so a repository cannot replace an agent that the user trusts
 * (the same rule as for skills and commands).
 *
 * An agent without `tools` gets the read-only tools only. Write tools and bash must be named.
 * Every call of the agent still passes the same permission engine, hooks and sandbox.
 */

export type AgentSource = "user" | "project";

export interface CustomAgent {
  name: string;
  source: AgentSource;
  /** Absolute path of the file. */
  file: string;
  /** The file as the user sees it: ~/.claude/agents/x.md or .garuda/agents/x.md. */
  shown: string;
  description: string;
  /** The agent's own instructions (its system prompt). */
  prompt: string;
  /**
   * Garuda tool names or MCP patterns (`mcp__server`, `mcp__server__tool`, `mcp__*`) from `tools`,
   * or undefined: the read-only tools.
   */
  tools?: string[];
  /** Names or patterns from `disallowedTools`. */
  disallowed: string[];
  /** A model for this agent (user agents only): `inherit`, an alias or a model id. */
  model?: string;
  /** From `maxTurns`: model calls per run. */
  maxSteps?: number;
  /** SHA-256 of the file, for the trust store. */
  hash: string;
}

export interface LoadedAgents {
  agents: CustomAgent[];
  problems: string[];
}

/** Claude Code's rule: no ":" and no leading "-". Garuda also keeps it short and simple. */
export const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const AGENT_MAX_CHARS = 50_000;
const DESCRIPTION_MAX_CHARS = 1_024;
const MAX_AGENTS = 50;
export const MAX_AGENT_STEPS = 100;

/** Claude Code tool names → Garuda tool names. Garuda names are accepted as they are. */
const CLAUDE_TOOLS: Record<string, string[]> = {
  Read: ["read_file"],
  Glob: ["glob"],
  Grep: ["grep"],
  Edit: ["edit_file"],
  MultiEdit: ["edit_file"],
  Write: ["write_file"],
  Bash: ["bash"],
  WebFetch: ["web_fetch"],
  WebSearch: ["web_search"],
  Skill: ["skill"],
  TodoWrite: ["todo_write"],
};

/** Garuda tools an agent may name. The agent and explore tools are never given: no nesting. */
export const AGENT_TOOL_NAMES = new Set([
  "read_file",
  "glob",
  "grep",
  "find_symbol",
  "find_references",
  "repo_map",
  "edit_file",
  "write_file",
  "bash",
  "web_fetch",
  "web_search",
  "remember",
  "skill",
  "todo_write",
]);

/** What an agent without `tools` gets. */
export const READ_ONLY_AGENT_TOOLS = [
  "read_file",
  "glob",
  "grep",
  "find_symbol",
  "find_references",
  "repo_map",
  "skill",
];

export function agentDirs(home: string, root: string) {
  return [
    { dir: join(home, ".garuda", "agents"), shown: "~/.garuda/agents", source: "user" as const },
    { dir: join(home, ".claude", "agents"), shown: "~/.claude/agents", source: "user" as const },
    { dir: join(root, ".garuda", "agents"), shown: ".garuda/agents", source: "project" as const },
    { dir: join(root, ".claude", "agents"), shown: ".claude/agents", source: "project" as const },
  ];
}

export async function loadAgents(options: { home: string; root: string }): Promise<LoadedAgents> {
  const problems: string[] = [];
  const byName = new Map<string, CustomAgent>();
  const seen = new Set<string>();
  for (const place of agentDirs(options.home, options.root)) {
    if (seen.has(place.dir)) continue;
    seen.add(place.dir);
    let entries: string[];
    try {
      entries = (await readdir(place.dir)).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = join(place.dir, entry);
      const shown = `${place.shown}/${entry}`;
      try {
        const info = await lstat(file);
        if (place.source === "project" && info.isSymbolicLink()) {
          problems.push(`${shown}: a project agent may not be a symbolic link; ignored.`);
          continue;
        }
        const text = await readFile(file, "utf8");
        if (text.length > AGENT_MAX_CHARS) {
          problems.push(`${shown}: longer than ${AGENT_MAX_CHARS} characters; ignored.`);
          continue;
        }
        const notes: string[] = [];
        const agent = parseAgent(text, { file, shown, source: place.source }, notes);
        for (const note of notes) problems.push(`${shown}: ${note}`);
        if (typeof agent === "string") {
          problems.push(`${shown}: ${agent}`);
        } else if (byName.has(agent.name)) {
          const first = byName.get(agent.name) as CustomAgent;
          problems.push(
            `${shown}: an agent named "${agent.name}" is already in ${first.shown}; that one wins.`,
          );
        } else if (byName.size >= MAX_AGENTS) {
          problems.push(`${shown}: more than ${MAX_AGENTS} agents; ignored.`);
        } else {
          byName.set(agent.name, agent);
        }
      } catch (error) {
        problems.push(`${shown}: ${(error as Error).message}`);
      }
    }
  }
  const agents = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { agents, problems };
}

/** An agent from its file, or the reason it is not valid. `notes` gets what Garuda leaves out. */
export function parseAgent(
  text: string,
  place: { file: string; shown: string; source: AgentSource },
  notes: string[] = [],
): CustomAgent | string {
  const { meta, body } = parseFrontmatterBlock(text);
  const name = meta.name;
  if (name === undefined) return "no name in the frontmatter; ignored.";
  if (!AGENT_NAME.test(name)) {
    return `the name "${name}" is not valid. Use letters, digits, "-" and "_" (up to 64).`;
  }
  const description = cleanText(meta.description ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DESCRIPTION_MAX_CHARS);
  if (description === "") return "no description in the frontmatter; ignored.";
  const clean = cleanText(body).trim();
  const prompt = place.source === "project" ? neutralizeTags(clean) : clean;
  if (prompt === "") return "the agent has no instructions; ignored.";

  const tools = meta.tools === undefined ? undefined : toolList(meta.tools, notes);
  const disallowed =
    meta.disallowedtools === undefined ? [] : toolList(meta.disallowedtools, notes);
  let model: string | undefined;
  if (meta.model !== undefined && meta.model !== "inherit") {
    if (place.source === "project") {
      notes.push(`"model: ${meta.model}" is left out: only you pick models, not the project.`);
    } else {
      model = meta.model;
    }
  }
  const turns = meta.maxturns === undefined ? undefined : Number.parseInt(meta.maxturns, 10);
  for (const key of ["permissionmode", "mcpservers", "memory", "isolation", "skills"]) {
    if (meta[key] !== undefined) notes.push(`"${key}" is left out: Garuda has no such option.`);
  }
  return {
    name,
    source: place.source,
    file: place.file,
    shown: place.shown,
    description,
    prompt,
    ...(tools === undefined ? {} : { tools }),
    disallowed,
    ...(model === undefined ? {} : { model }),
    ...(turns !== undefined && Number.isFinite(turns) && turns > 0
      ? { maxSteps: Math.min(turns, MAX_AGENT_STEPS) }
      : {}),
    hash: createHash("sha256").update(text).digest("hex"),
  };
}

/** `Read, Grep, Bash(git *)` → `read_file, grep, bash`. Unknown names get a note. */
function toolList(value: string, notes: string[]): string[] {
  const out: string[] = [];
  for (const raw of value.split(/[,\s]+(?![^(]*\))/)) {
    const item = raw.trim();
    if (item === "") continue;
    const base = item.replace(/\(.*\)$/, "");
    if (base !== item)
      notes.push(`"${item}": the part in brackets is left out; Garuda's rules decide.`);
    if (base.startsWith("mcp__")) {
      out.push(base);
    } else if (CLAUDE_TOOLS[base] !== undefined) {
      out.push(...(CLAUDE_TOOLS[base] as string[]));
    } else if (AGENT_TOOL_NAMES.has(base)) {
      out.push(base);
    } else {
      notes.push(`the tool "${base}" is left out: Garuda has no such tool for agents.`);
    }
  }
  return [...new Set(out)];
}

/** True when the tool name matches an entry of an agent's list (a name or an MCP pattern). */
export function toolMatches(name: string, entry: string): boolean {
  if (entry === name) return true;
  if (entry.endsWith("*")) return name.startsWith(entry.slice(0, -1));
  // `mcp__server` means every tool of that server.
  return (
    entry.startsWith("mcp__") && entry.split("__").length === 2 && name.startsWith(`${entry}__`)
  );
}

/** The consent question for a project agent, with its full instructions and tools. */
export function agentConsent(
  agent: CustomAgent,
  tools: readonly string[],
  changed: boolean,
  isolation: ApprovalRequest["isolation"],
): ApprovalRequest {
  const lines = [
    changed
      ? `The project agent "${agent.name}" changed since you allowed it (${agent.shown}).`
      : `"${agent.name}" is a project agent from ${agent.shown}.`,
    `Its tools: ${tools.join(", ")}.`,
    ...(agent.maxSteps === undefined
      ? []
      : [`Its step limit: ${agent.maxSteps} (at most your own).`]),
    "Its instructions:",
    "",
    ...agent.prompt.split("\n").map((line) => `  │ ${line}`),
    "",
    "Its tool calls still ask or run in the sandbox, as usual.",
    "Allow it only if you trust this project.",
  ];
  return {
    tool: "agent",
    target: { kind: "input", json: JSON.stringify({ agent: agent.name, file: agent.shown }) },
    preview: lines.join("\n"),
    isolation,
    title: `Use the project agent "${agent.name}"?`,
    labels: {
      once: "Yes, for this session only",
      session: "Yes, and remember (asks again if the file changes)",
      deny: "No",
    },
  };
}
