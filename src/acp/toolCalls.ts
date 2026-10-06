import { resolve } from "node:path";
import type { ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { visible } from "../cli/approver.js";

/**
 * How a Garuda tool call looks in the editor (ACP, 0.15): a one-line title, the ACP kind (the
 * editor picks an icon from it) and the files it touches, so the editor can follow the agent.
 */
export interface CallView {
  title: string;
  kind: ToolKind;
  locations: ToolCallLocation[];
}

/** The longest title, in characters. */
export const TITLE_MAX = 200;

const KINDS: Readonly<Record<string, ToolKind>> = {
  read_file: "read",
  skill: "read",
  glob: "search",
  grep: "search",
  find_symbol: "search",
  find_references: "search",
  find_callers: "search",
  repo_map: "search",
  ast_query: "search",
  impact_analysis: "search",
  write_file: "edit",
  edit_file: "edit",
  remember: "edit",
  bash: "execute",
  process_manager: "execute",
  web_fetch: "fetch",
  web_search: "fetch",
  explore: "think",
  agent: "think",
  delegate_expert: "think",
  todo_write: "think",
};

/** One line for a title: new lines become ↵, hidden characters become visible, long text is cut. */
export function oneLine(text: string, max = TITLE_MAX): string {
  const line = visible(text.replace(/\r?\n/g, " ↵ "));
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** The title, kind and locations of one call. `input` is the model's input, not yet checked. */
export function viewOf(name: string, input: unknown, root: string): CallView {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const text = (key: string): string | undefined =>
    typeof args[key] === "string" ? (args[key] as string) : undefined;
  const path = text("path");
  const kind = KINDS[name] ?? "other";
  const locations: ToolCallLocation[] =
    path === undefined || !["read", "edit", "search"].includes(kind)
      ? []
      : [
          {
            path: resolve(root, path),
            ...(typeof args.offset === "number" ? { line: args.offset } : {}),
          },
        ];
  return { title: oneLine(titleOf(name, text, path)), kind, locations };
}

function titleOf(
  name: string,
  text: (key: string) => string | undefined,
  path: string | undefined,
): string {
  switch (name) {
    case "read_file":
      return `Read ${path ?? ""}`;
    case "write_file":
      return `Write ${path ?? ""}`;
    case "edit_file":
      return `Edit ${path ?? ""}`;
    case "glob":
      return `Find files ${text("pattern") ?? ""}`;
    case "grep":
      return `Search ${text("pattern") ?? ""}${path === undefined ? "" : ` in ${path}`}`;
    case "bash":
      return `$ ${text("command") ?? ""}`;
    case "web_fetch":
      return `Fetch ${text("url") ?? ""}`;
    case "web_search":
      return `Search the web: ${text("query") ?? ""}`;
    case "explore":
      return "Subagent: explore";
    case "agent":
      return `Subagent: ${text("agent") ?? "agent"}`;
    case "delegate_expert":
      return `Subagent: ${text("language") ?? "expert"} expert`;
    case "todo_write":
      return "Update the plan";
    case "remember":
      return "Remember a note";
    case "skill":
      return `Skill: ${text("name") ?? ""}`;
    default: {
      // MCP tools are named mcp__<server>__<tool>.
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      if (mcp !== null) return `${mcp[1]}/${mcp[2]}`;
      const symbol = text("symbol") ?? text("name") ?? text("query");
      return symbol === undefined ? name : `${name} ${symbol}`;
    }
  }
}
