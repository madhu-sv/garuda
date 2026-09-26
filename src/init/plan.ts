import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BUILTIN_COMMANDS } from "../commands/builtins.js";
import type {
  CommandItem,
  ImportItem,
  InstructionsItem,
  McpItem,
  RuleItem,
  SkippedItem,
} from "./types.js";

/**
 * The init plan (0.5): where each imported item goes, and the files to write. The rule is "new files
 * only": an existing mcp.json, settings.json or command file is never changed; its items are
 * listed as skipped. The only change to an existing file is adding missing lines to .gitignore.
 */

export interface FileWrite {
  path: string;
  /** For the preview: relative to the root, or ~/… */
  shown: string;
  content: string;
  mode: "new" | "append";
}

export interface PlanLine {
  item: ImportItem;
  /** Where it goes, or why it does not. */
  target?: string;
  reason?: string;
}

export interface InitPlan {
  writes: FileWrite[];
  lines: PlanLine[];
  /** Other agents' instruction files, for the init turn. */
  instructions: InstructionsItem[];
}

/** Lines Garuda adds to .gitignore: local state that must not be committed. */
export const GITIGNORE_LINES = [".garuda/sessions/", ".garuda/index/", ".garuda/evals/"];

export function buildPlan(
  items: readonly ImportItem[],
  options: { root: string; home: string; defaults: boolean },
): InitPlan {
  const { root, home } = options;
  const lines: PlanLine[] = [];
  const writes: FileWrite[] = [];
  const instructions = items.filter((i): i is InstructionsItem => i.kind === "instructions");

  // MCP servers: one new mcp.json per scope.
  for (const scope of ["user", "project"] as const) {
    const file =
      scope === "user" ? join(home, ".garuda", "mcp.json") : join(root, ".garuda", "mcp.json");
    const shown = scope === "user" ? "~/.garuda/mcp.json" : ".garuda/mcp.json";
    const servers: Record<string, unknown> = {};
    for (const item of items.filter((i): i is McpItem => i.kind === "mcp" && i.scope === scope)) {
      if (existsSync(file)) {
        lines.push({ item, reason: `${shown} exists; add it there by hand` });
      } else if (item.name in servers) {
        lines.push({ item, reason: `a server named "${item.name}" is already in the list` });
      } else {
        servers[item.name] = item.def;
        lines.push({ item, target: shown });
      }
    }
    if (Object.keys(servers).length > 0) {
      writes.push({
        path: file,
        shown,
        content: `${JSON.stringify({ servers }, null, 2)}\n`,
        mode: "new",
      });
    }
  }

  // Commands: one file each.
  const taken = new Set<string>();
  for (const item of items.filter((i): i is CommandItem => i.kind === "command")) {
    const base =
      item.scope === "user" ? join(home, ".garuda", "commands") : join(root, ".garuda", "commands");
    const rel = `${item.name.split(":").join("/")}.md`;
    const file = join(base, rel);
    const shown = `${item.scope === "user" ? "~/" : ""}.garuda/commands/${rel}`;
    const key = `${item.scope}:${item.name}`;
    if (BUILTIN_COMMANDS.includes(item.name)) {
      lines.push({ item, reason: `/${item.name} is a built-in command` });
    } else if (existsSync(file) || taken.has(key)) {
      lines.push({ item, reason: `${shown} exists` });
    } else {
      taken.add(key);
      writes.push({ path: file, shown, content: item.text, mode: "new" });
      lines.push({ item, target: shown });
    }
  }

  // Permission rules and defaults: a new .garuda/settings.json.
  const settingsFile = join(root, ".garuda", "settings.json");
  const rules = items.filter((i): i is RuleItem => i.kind === "rule");
  const allow: string[] = [];
  const deny: string[] = [];
  for (const item of rules) {
    if (existsSync(settingsFile)) {
      lines.push({ item, reason: ".garuda/settings.json exists; add it there by hand" });
      continue;
    }
    const list = item.list === "allow" ? allow : deny;
    if (!list.includes(item.rule)) list.push(item.rule);
    lines.push({ item, target: `.garuda/settings.json (${item.list})` });
  }
  if (!existsSync(settingsFile) && (options.defaults || allow.length + deny.length > 0)) {
    const settings = {
      executor: "auto",
      permissions: { allow, deny },
      undo: { enabled: true },
      lsp: { enabled: false },
    };
    writes.push({
      path: settingsFile,
      shown: ".garuda/settings.json",
      content: `${JSON.stringify(settings, null, 2)}\n`,
      mode: "new",
    });
  }

  // .gitignore: Garuda's local state.
  if (options.defaults) {
    const file = join(root, ".gitignore");
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
    const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
    if (missing.length > 0) {
      const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
      writes.push({
        path: file,
        shown: ".gitignore",
        content: `${prefix}# Garuda's local state\n${missing.join("\n")}\n`,
        mode: current === "" ? "new" : "append",
      });
    }
  }

  for (const item of items) {
    if (item.kind === "skipped")
      lines.push({ item, reason: (item as SkippedItem).notes[0] ?? "not supported" });
    if (item.kind === "instructions") lines.push({ item, target: "read by the init turn" });
  }
  return { writes, lines, instructions };
}

/** The preview for the question: per agent, what goes where; then the files. */
export function previewText(plan: InitPlan): string {
  const out: string[] = [];
  const agents = [...new Set(plan.lines.map((l) => l.item.agent))];
  for (const agent of agents) {
    out.push(`From ${agent}:`);
    for (const { item, target, reason } of plan.lines.filter((l) => l.item.agent === agent)) {
      const what =
        item.kind === "instructions" ? describe(item) : `${describe(item)} (${item.source})`;
      if (target !== undefined) {
        out.push(`  + ${what} → ${target}`);
        for (const note of item.notes) out.push(`      ! ${note}`);
      } else {
        out.push(`  - ${what}: ${reason}`);
      }
    }
  }
  if (plan.writes.length > 0) {
    out.push("Files:");
    for (const w of plan.writes) out.push(`  ${w.mode === "new" ? "new   " : "append"} ${w.shown}`);
  }
  return out.join("\n");
}

function describe(item: ImportItem): string {
  switch (item.kind) {
    case "mcp":
      return `MCP server ${item.name}`;
    case "command":
      return `command /${item.name}`;
    case "rule":
      return `${item.list} rule ${item.rule}`;
    case "instructions":
      return `instructions ${item.path}`;
    case "skipped":
      return item.what;
  }
}

/** Write the plan's files. New files are created with `wx`: a file that appeared since the plan wins. */
export async function applyPlan(plan: InitPlan): Promise<string[]> {
  const done: string[] = [];
  for (const w of plan.writes) {
    await mkdir(dirname(w.path), { recursive: true });
    try {
      await writeFile(w.path, w.content, { flag: w.mode === "new" ? "wx" : "a" });
      done.push(w.shown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return done;
}
