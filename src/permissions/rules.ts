import type { CallTarget } from "./types.js";

/**
 * Permission rules (F19). Syntax: `tool` or `tool(pattern)`.
 *   edit_file                any edit
 *   edit_file(src/**)        edits under src/
 *   read_file(.env.example)  a file name without "/" matches at any depth
 *   bash(pnpm test*)         a command; "*" matches any characters
 *   mcp__github__*           every tool of an MCP server (a "*" at the end of a tool name)
 *   web_fetch(docs.python.org)  a host; web_fetch(*.github.com) matches its subdomains
 */
export interface Rule {
  tool: string;
  pattern?: string;
  /** Session rules from "allow for session" match the command exactly, with no wildcards. */
  exact?: boolean;
}

const RULE = /^([a-z_][a-z0-9_-]*\*?)(?:\((.*)\))?$/i;

export function parseRule(text: string): Rule {
  const match = RULE.exec(text.trim());
  if (match === null || match[1] === undefined) {
    throw new Error(`Invalid permission rule "${text}". Use "tool" or "tool(pattern)".`);
  }
  const pattern = match[2]?.trim();
  return pattern === undefined || pattern === "" ? { tool: match[1] } : { tool: match[1], pattern };
}

export function formatRule(rule: Rule): string {
  return rule.pattern === undefined ? rule.tool : `${rule.tool}(${rule.pattern})`;
}

/**
 * True when `rule` covers the call.
 * `mode` matters for commands with several parts (`a && b`):
 * an allow rule must cover every part, a deny rule needs only one part.
 */
export function ruleMatches(
  rule: Rule,
  tool: string,
  target: CallTarget | undefined,
  mode: "allow" | "deny",
): boolean {
  if (!toolMatches(rule.tool, tool)) return false;
  if (rule.pattern === undefined) return true;
  if (target === undefined) return false;

  if (target.kind === "path") return pathMatches(rule.pattern, target.path);
  if (target.kind === "input") return false;
  if (target.kind === "url") return hostMatches(rule.pattern, target.host);

  if (rule.exact) return normalize(target.command) === normalize(rule.pattern);
  // An allow rule matches the command as written: `NODE_OPTIONS=… pnpm test` or `sudo pnpm test` is
  // not `pnpm test` (review finding). A deny rule still looks through the prefixes, to catch more.
  const parts = commandParts(target.command, mode === "deny");
  if (parts.length === 0) return false;
  const hit = (part: string) => commandMatches(rule.pattern ?? "", part);
  return mode === "allow" ? parts.every(hit) : parts.some(hit) || hit(target.command);
}

function toolMatches(ruleTool: string, tool: string): boolean {
  return ruleTool.endsWith("*") ? tool.startsWith(ruleTool.slice(0, -1)) : ruleTool === tool;
}

/** "example.com" matches only that host; "*.example.com" matches its subdomains. */
export function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  return p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : p === h;
}

// Paths.

/** Glob match on a root-relative path. A pattern without "/" matches at any depth. */
export function pathMatches(pattern: string, path: string): boolean {
  const full = pattern.includes("/") ? pattern.replace(/^\.?\//, "") : `**/${pattern}`;
  return globToRegExp(full).test(path);
}

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (glob.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 2;
    } else if (glob.startsWith("**", i)) {
      out += ".*";
      i += 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += escapeRegExp(c);
  }
  return new RegExp(`^${out}$`);
}

// Commands.

export function commandMatches(pattern: string, command: string): boolean {
  const regex = normalize(pattern).split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${regex}$`, "s").test(normalize(command));
}

/**
 * Split a shell command into simple commands, outside quotes:
 * at ; & && | || newlines, $( ) and backticks. Leading `sudo`, `env` and
 * VAR=value words are removed, so `sudo rm -rf x` still matches `rm -rf*` (deny rules and the team
 * policy; allow rules keep them, with `stripPrefixesToo` false).
 * This is a guard for rules, not a full shell parser. Approval remains the main control.
 */
export function commandParts(command: string, stripPrefixesToo = true): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"') {
        current += c + (command[i + 1] ?? "");
        i++;
        continue;
      }
      current += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (c === "\\") {
      current += c + (command[i + 1] ?? "");
      i++;
    } else if (";&|\n`()".includes(c) || (c === "$" && command[i + 1] === "(")) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  return parts
    .map((part) => (stripPrefixesToo ? stripPrefixes(part) : normalize(part)))
    .filter((part) => part !== "");
}

function stripPrefixes(part: string): string {
  let words = normalize(part)
    .replace(/^[{}!\s]+/, "")
    .split(" ");
  for (;;) {
    const first = words[0] ?? "";
    if (first === "sudo" || first === "env" || first === "exec" || first === "command") {
      words = words.slice(1);
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) words = words.slice(1);
    else break;
  }
  return words.join(" ").replace(/[{}\s]+$/, "");
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
