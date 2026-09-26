import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { checkServerUrl } from "../mcp/config.js";
import {
  claudeRule,
  commandFromMarkdown,
  commandFromToml,
  commandPart,
  convertEnv,
  openCodeRules,
  parseJsonc,
  serverName,
} from "./convert.js";
import type { AgentName, ImportItem, Scope } from "./types.js";

/**
 * Readers for other coding agents' files (0.5). They only read; nothing runs. A file that is
 * missing gives nothing; a file that does not parse gives one "skipped" item.
 *
 * | Agent | MCP servers | Commands | Rules | Instructions |
 * | Claude Code | .mcp.json, ~/.claude.json | .claude/commands | .claude/settings(.local).json | (CLAUDE.md: read natively) |
 * | OpenCode | opencode.json(c), ~/.config/opencode | .opencode/command(s), "command" | "permission" | (AGENTS.md: native) |
 * | Codex | .codex/config.toml, ~/.codex/config.toml | ~/.codex/prompts | – | (AGENTS.md: native) |
 * | Gemini CLI | .gemini/settings.json, ~/.gemini | .gemini/commands (TOML) | – | GEMINI.md |
 * | Tabnine | .tabnine/agent/settings.json, .tabnine/mcp_servers.json, ~ | .tabnine/agent/commands (TOML) | – | TABNINE.md, .tabnine/guidelines |
 * | Cursor | .cursor/mcp.json, ~/.cursor/mcp.json | – | – | .cursorrules, .cursor/rules/*.mdc |
 * | Copilot | – | – | – | .github/copilot-instructions.md, .github/instructions |
 */

export interface SourceOptions {
  root: string;
  home: string;
}

const MAX_FILES = 200;

/** An argument that looks like it carries a secret (a flag name or a known token prefix). */
const SECRET_ARG = /(token|api[-_]?key|secret|password)|^(sk-|ghp_|xox[bp]-)/i;

export function readAllSources(options: SourceOptions): ImportItem[] {
  return [
    ...claudeCode(options),
    ...openCode(options),
    ...codex(options),
    ...geminiLike("Gemini CLI", options, {
      settings: [
        ["project", ".gemini/settings.json"],
        ["user", ".gemini/settings.json"],
      ],
      commands: [
        ["project", ".gemini/commands"],
        ["user", ".gemini/commands"],
      ],
      instructions: ["GEMINI.md"],
    }),
    ...geminiLike("Tabnine", options, {
      settings: [
        ["project", ".tabnine/agent/settings.json"],
        ["project", ".tabnine/mcp_servers.json"],
        ["user", ".tabnine/agent/settings.json"],
      ],
      commands: [
        ["project", ".tabnine/agent/commands"],
        ["user", ".tabnine/agent/commands"],
      ],
      instructions: ["TABNINE.md", ".tabnine/guidelines"],
    }),
    ...cursor(options),
    ...instructions("Copilot", options, [
      ".github/copilot-instructions.md",
      ".github/instructions",
    ]),
  ];
}

// Claude Code.

function claudeCode({ root, home }: SourceOptions): ImportItem[] {
  const agent: AgentName = "Claude Code";
  const out: ImportItem[] = [];
  const mcp = readJsonFile(join(root, ".mcp.json"), agent, out);
  out.push(...mcpServers(agent, ".mcp.json", "project", field(mcp, "mcpServers"), "claude"));
  const global = readJsonFile(join(home, ".claude.json"), agent, out);
  out.push(...mcpServers(agent, "~/.claude.json", "user", field(global, "mcpServers"), "claude"));
  const perProject = field(field(global, "projects"), root);
  out.push(
    ...mcpServers(
      agent,
      "~/.claude.json (this project)",
      "project",
      field(perProject, "mcpServers"),
      "claude",
    ),
  );
  out.push(...markdownCommands(agent, "project", root, ".claude/commands"));
  out.push(...markdownCommands(agent, "user", home, ".claude/commands"));
  for (const file of [".claude/settings.json", ".claude/settings.local.json"]) {
    const settings = readJsonFile(join(root, file), agent, out);
    const permissions = field(settings, "permissions");
    for (const list of ["allow", "deny"] as const) {
      for (const text of arrayOf(field(permissions, list))) {
        const rules = claudeRule(String(text));
        if (rules === undefined) {
          out.push(skipped(agent, file, `the rule ${String(text)}`, "Garuda has no such tool"));
        } else {
          for (const rule of rules)
            out.push({ kind: "rule", agent, source: file, notes: [], list, rule });
        }
      }
    }
    if (field(settings, "hooks") !== undefined) {
      out.push(skipped(agent, file, "hooks", "their format differs; see ~/.garuda/hooks.json"));
    }
  }
  const userSettings = readJsonFile(join(home, ".claude/settings.json"), agent, out);
  if (field(userSettings, "permissions") !== undefined) {
    out.push(
      skipped(
        agent,
        "~/.claude/settings.json",
        "your personal permission rules",
        "Garuda has project settings only",
      ),
    );
  }
  // Skills in .claude/skills and ~/.claude/skills need no import: Garuda reads them there (0.5).
  return out;
}

// OpenCode.

function openCode({ root, home }: SourceOptions): ImportItem[] {
  const agent: AgentName = "OpenCode";
  const out: ImportItem[] = [];
  const files: [Scope, string, string][] = [
    ["project", root, "opencode.json"],
    ["project", root, "opencode.jsonc"],
    ["user", home, ".config/opencode/opencode.json"],
    ["user", home, ".config/opencode/opencode.jsonc"],
  ];
  for (const [scope, base, file] of files) {
    const shown = scope === "user" ? `~/${file}` : file;
    const config = readJsonFile(join(base, file), agent, out);
    if (config === undefined) continue;
    for (const [name, raw] of Object.entries(objectOf(field(config, "mcp")))) {
      const def = objectOf(raw);
      if (def.type === "local") {
        const cmd = arrayOf(def.command).map(String);
        out.push(
          ...mcpServers(agent, shown, scope, {
            [name]: {
              command: cmd[0],
              args: cmd.slice(1),
              env: def.environment,
              enabled: def.enabled,
            },
          }),
        );
      } else if (def.type === "remote") {
        out.push(
          ...mcpServers(agent, shown, scope, {
            [name]: { url: def.url, headers: def.headers, enabled: def.enabled },
          }),
        );
      }
    }
    for (const [name, raw] of Object.entries(objectOf(field(config, "command")))) {
      const def = objectOf(raw);
      const notes: string[] = [];
      const md = `${typeof def.description === "string" ? `---\ndescription: ${def.description}\n---\n` : ""}${String(def.template ?? "")}`;
      const part = commandPart(name);
      if (part === undefined || typeof def.template !== "string") {
        out.push(skipped(agent, shown, `the command ${name}`, "no valid name or template"));
        continue;
      }
      out.push({
        kind: "command",
        agent,
        source: shown,
        notes,
        scope,
        name: part,
        text: commandFromMarkdown(md, notes),
      });
    }
    if (scope === "project") {
      for (const { list, rule } of openCodeRules(field(config, "permission"))) {
        out.push({ kind: "rule", agent, source: shown, notes: [], list, rule });
      }
    } else if (field(config, "permission") !== undefined) {
      out.push(
        skipped(agent, shown, "your personal permission rules", "Garuda has project settings only"),
      );
    }
  }
  for (const dir of [".opencode/command", ".opencode/commands"])
    out.push(...markdownCommands(agent, "project", root, dir));
  for (const dir of [".config/opencode/command", ".config/opencode/commands"]) {
    out.push(...markdownCommands(agent, "user", home, dir));
  }
  return out;
}

// Codex.

function codex({ root, home }: SourceOptions): ImportItem[] {
  const agent: AgentName = "Codex";
  const out: ImportItem[] = [];
  for (const [scope, base, shown] of [
    ["project", root, ".codex/config.toml"],
    ["user", home, "~/.codex/config.toml"],
  ] as const) {
    const config = readTomlFile(join(base, ".codex/config.toml"), agent, out);
    for (const [name, raw] of Object.entries(objectOf(field(config, "mcp_servers")))) {
      const def = objectOf(raw);
      const env: Record<string, unknown> = { ...objectOf(def.env) };
      for (const v of arrayOf(def.env_vars)) env[String(v)] = `\${${String(v)}}`;
      const headers =
        def.http_headers ??
        (def.bearer_token_env_var === undefined ? undefined : { Authorization: "…" });
      out.push(...mcpServers(agent, shown, scope, { [name]: { ...def, env, headers } }));
    }
  }
  out.push(...markdownCommands(agent, "user", home, ".codex/prompts"));
  return out;
}

// Gemini CLI and Tabnine (Tabnine's CLI uses the same formats).

function geminiLike(
  agent: AgentName,
  { root, home }: SourceOptions,
  paths: { settings: [Scope, string][]; commands: [Scope, string][]; instructions: string[] },
): ImportItem[] {
  const out: ImportItem[] = [];
  for (const [scope, file] of paths.settings) {
    const base = scope === "user" ? home : root;
    const settings = readJsonFile(join(base, file), agent, out);
    const shown = scope === "user" ? `~/${file}` : file;
    out.push(...mcpServers(agent, shown, scope, field(settings, "mcpServers"), "gemini"));
  }
  for (const [scope, dir] of paths.commands) {
    const base = scope === "user" ? home : root;
    for (const file of listFiles(join(base, dir), ".toml")) {
      const shown = `${scope === "user" ? "~/" : ""}${dir}/${file}`;
      const name = commandName(file, ".toml");
      const data = readTomlFile(join(base, dir, file), agent, out);
      const notes: string[] = [];
      const text = data === undefined ? undefined : commandFromToml(data, notes);
      if (name === undefined || text === undefined) {
        out.push(skipped(agent, shown, "a command", "no valid name or prompt"));
        continue;
      }
      out.push({ kind: "command", agent, source: shown, notes, scope, name, text });
    }
  }
  out.push(...instructions(agent, { root, home }, paths.instructions));
  return out;
}

// Cursor.

function cursor({ root, home }: SourceOptions): ImportItem[] {
  const agent: AgentName = "Cursor";
  const out: ImportItem[] = [];
  const project = readJsonFile(join(root, ".cursor/mcp.json"), agent, out);
  out.push(...mcpServers(agent, ".cursor/mcp.json", "project", field(project, "mcpServers")));
  const user = readJsonFile(join(home, ".cursor/mcp.json"), agent, out);
  out.push(...mcpServers(agent, "~/.cursor/mcp.json", "user", field(user, "mcpServers")));
  out.push(...instructions(agent, { root, home }, [".cursorrules", ".cursor/rules"]));
  return out;
}

// Shared parts.

/**
 * MCP servers in the common `mcpServers` shape: `{command, args, env}` or a URL. `dialect` covers
 * the differences: Claude's `type: "sse"` and Gemini's `url` (SSE) versus `httpUrl`.
 */
function mcpServers(
  agent: AgentName,
  source: string,
  scope: Scope,
  servers: unknown,
  dialect: "claude" | "gemini" | "plain" = "plain",
): ImportItem[] {
  const out: ImportItem[] = [];
  for (const [rawName, raw] of Object.entries(objectOf(servers))) {
    const def = objectOf(raw);
    const name = serverName(rawName);
    if (name === undefined) {
      out.push(
        skipped(
          agent,
          source,
          `the MCP server "${rawName}"`,
          "its name does not fit Garuda's rules",
        ),
      );
      continue;
    }
    const notes: string[] = [];
    if (def.enabled === false || def.disabled === true) notes.push("it was off; it stays off");
    const enabled = !(def.enabled === false || def.disabled === true);
    const sse =
      (dialect === "claude" && def.type === "sse") ||
      (dialect === "gemini" && def.url !== undefined && def.httpUrl === undefined);
    const url = dialect === "gemini" ? def.httpUrl : def.url;
    if (sse) {
      out.push(
        skipped(
          agent,
          source,
          `the MCP server "${rawName}"`,
          "it uses SSE; Garuda supports Streamable HTTP only",
        ),
      );
      continue;
    }
    if (typeof url === "string") {
      const problem = checkServerUrl(url, scope);
      if (problem !== undefined) {
        out.push(skipped(agent, source, `the MCP server "${rawName}"`, problem));
        continue;
      }
      if (def.headers !== undefined && Object.keys(objectOf(def.headers)).length > 0) {
        notes.push(
          "it sent HTTP headers (for example a token); Garuda sends none and signs in with OAuth if the server asks",
        );
      }
      out.push({
        kind: "mcp",
        agent,
        source,
        notes,
        scope,
        name,
        def: { url, ...(enabled ? {} : { enabled: false }) },
      });
      continue;
    }
    if (typeof def.command !== "string" || def.command === "") {
      out.push(skipped(agent, source, `the MCP server "${rawName}"`, "no command and no URL"));
      continue;
    }
    if (arrayOf(def.args).some((a) => SECRET_ARG.test(String(a)))) {
      notes.push("its arguments may hold a secret; check them in the new file");
    }
    if (def.cwd !== undefined)
      notes.push("its working folder (cwd) is left out; Garuda starts it in the project");
    notes.push(
      'it runs in the sandbox with no network; add "network": true if it needs the internet',
    );
    out.push({
      kind: "mcp",
      agent,
      source,
      notes,
      scope,
      name,
      def: {
        command: def.command,
        args: arrayOf(def.args).map(String),
        env: convertEnv(objectOf(def.env), source, notes),
        ...(enabled ? {} : { enabled: false }),
      },
    });
  }
  return out;
}

function markdownCommands(agent: AgentName, scope: Scope, base: string, dir: string): ImportItem[] {
  const out: ImportItem[] = [];
  for (const file of listFiles(join(base, dir), ".md")) {
    const shown = `${scope === "user" ? "~/" : ""}${dir}/${file}`;
    const name = commandName(file, ".md");
    if (name === undefined) {
      out.push(skipped(agent, shown, "a command", "its name does not fit Garuda's rules"));
      continue;
    }
    const notes: string[] = [];
    const text = commandFromMarkdown(readFileSync(join(base, dir, file), "utf8"), notes);
    out.push({ kind: "command", agent, source: shown, notes, scope, name, text });
  }
  return out;
}

/** Instruction files and folders of Markdown files (project only). */
function instructions(agent: AgentName, { root }: SourceOptions, paths: string[]): ImportItem[] {
  const out: ImportItem[] = [];
  for (const path of paths) {
    const full = join(root, path);
    if (!existsSync(full)) continue;
    const files = statSync(full).isDirectory()
      ? listFiles(full, [".md", ".mdc"]).map((f) => `${path}/${f}`)
      : [path];
    for (const file of files)
      out.push({ kind: "instructions", agent, source: file, notes: [], path: file });
  }
  return out;
}

/** "git/commit.toml" → "git:commit". */
function commandName(file: string, ext: string): string | undefined {
  const parts = file.slice(0, -ext.length).split("/").map(commandPart);
  return parts.every((p) => p !== undefined) ? parts.join(":") : undefined;
}

function listFiles(dir: string, ext: string | string[]): string[] {
  const exts = Array.isArray(ext) ? ext : [ext];
  const out: string[] = [];
  const walk = (current: string) => {
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= MAX_FILES) return;
      const full = join(current, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile() && exts.some((e) => name.endsWith(e))) {
        out.push(relative(dir, full).split(sep).join("/"));
      }
    }
  };
  walk(dir);
  return out;
}

function readJsonFile(
  path: string,
  agent: AgentName,
  out: ImportItem[],
): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return objectOf(parseJsonc(readFileSync(path, "utf8")));
  } catch (error) {
    out.push(
      skipped(
        agent,
        path,
        "a settings file",
        `it does not parse: ${(error as Error).message.slice(0, 80)}`,
      ),
    );
    return undefined;
  }
}

let toml: typeof import("smol-toml") | undefined;

function readTomlFile(
  path: string,
  agent: AgentName,
  out: ImportItem[],
): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  if (toml === undefined) {
    out.push(skipped(agent, path, "a TOML file", "the TOML reader is not loaded"));
    return undefined;
  }
  try {
    return objectOf(toml.parse(readFileSync(path, "utf8")));
  } catch (error) {
    out.push(
      skipped(
        agent,
        path,
        "a TOML file",
        `it does not parse: ${(error as Error).message.split("\n")[0]}`,
      ),
    );
    return undefined;
  }
}

/** Load the TOML reader before readAllSources (it loads on demand, N3). */
export async function loadToml(): Promise<void> {
  toml ??= await import("smol-toml");
}

function skipped(agent: AgentName, source: string, what: string, why: string): ImportItem {
  return { kind: "skipped", agent, source, notes: [why], what };
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
