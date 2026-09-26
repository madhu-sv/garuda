/**
 * What `init` can bring over from other coding agents (0.5). Readers (sources.ts) turn each agent's
 * files into these items; plan.ts decides where each one goes; apply.ts writes new files only.
 */

export type AgentName =
  | "Claude Code"
  | "OpenCode"
  | "Codex"
  | "Gemini CLI"
  | "Tabnine"
  | "Cursor"
  | "Copilot";

export type Scope = "user" | "project";

interface Base {
  agent: AgentName;
  /** The file it came from, for the preview. */
  source: string;
  /** Things the user must know (a secret moved to an env reference, a feature Garuda lacks). */
  notes: string[];
}

/** An MCP server, already in Garuda's mcp.json shape. */
export interface McpItem extends Base {
  kind: "mcp";
  scope: Scope;
  name: string;
  def: Record<string, unknown>;
}

/** A custom slash command, as the text of a Garuda command file. */
export interface CommandItem extends Base {
  kind: "command";
  scope: Scope;
  /** Garuda name, with ":" for subfolders. */
  name: string;
  text: string;
}

/** A permission rule in Garuda syntax (project settings only). */
export interface RuleItem extends Base {
  kind: "rule";
  list: "allow" | "deny";
  rule: string;
}

/** An instruction file of another agent: the init turn reads it and carries over what applies. */
export interface InstructionsItem extends Base {
  kind: "instructions";
  /** Path relative to the root. */
  path: string;
}

/** Something found that Garuda does not import, with the reason. */
export interface SkippedItem extends Base {
  kind: "skipped";
  what: string;
}

export type ImportItem = McpItem | CommandItem | RuleItem | InstructionsItem | SkippedItem;
