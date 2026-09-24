import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * MCP server configuration (0.2). Two files, same format:
 *   ~/.garuda/mcp.json         the user's own servers: trusted
 *   <root>/.garuda/mcp.json    project servers: they can come from a cloned repo, so each one
 *                              needs the user's consent, pinned to a hash of its definition
 *
 * {
 *   "servers": {
 *     "github": {
 *       "command": "github-mcp-server",
 *       "args": ["stdio"],
 *       "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
 *       "network": true
 *     }
 *   }
 * }
 *
 * Only stdio servers in 0.2. `${NAME}` in an env value takes NAME from Garuda's environment.
 * Garuda passes no other variables than its normal allowlist and these.
 */

export const MCP_FILE = join(".garuda", "mcp.json");

/** Server names become part of tool names: mcp__<server>__<tool>. */
export const SERVER_NAME = /^[a-z0-9][a-z0-9_]{0,31}$/;

const serverSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
  /** The server may use the network. Default: no network (it runs in the OS sandbox). */
  network: z.boolean().default(false),
  /** Extra writable paths. `~/` is the home folder; relative paths start at the root. */
  writePaths: z.array(z.string()).default([]),
  /** Time limit for one tool call. */
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
  enabled: z.boolean().default(true),
});

const fileSchema = z.strictObject({
  servers: z.record(z.string(), serverSchema).default({}),
});

export type ServerDef = z.infer<typeof serverSchema>;
export type ServerSource = "user" | "project";

export interface ServerConfig {
  name: string;
  source: ServerSource;
  /** The file it came from, for messages. */
  file: string;
  def: ServerDef;
}

export interface McpPaths {
  home: string;
  root: string;
}

/**
 * Read both files. A project server with the same name as a user server is ignored:
 * a repo must not replace a server the user trusts.
 */
export async function loadMcpConfig(
  { home, root }: McpPaths = { home: homedir(), root: process.cwd() },
): Promise<{ servers: ServerConfig[]; problems: string[] }> {
  const problems: string[] = [];
  const read = async (source: ServerSource, file: string): Promise<ServerConfig[]> => {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      problems.push(`${file}: ${(error as Error).message}`);
      return [];
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      problems.push(`${file}: invalid JSON: ${(error as Error).message}`);
      return [];
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) {
      problems.push(`${file}: ${z.prettifyError(parsed.error)}`);
      return [];
    }
    const out: ServerConfig[] = [];
    for (const [name, def] of Object.entries(parsed.data.servers)) {
      if (!SERVER_NAME.test(name)) {
        problems.push(
          `${file}: server name "${name}" is not valid. Use lowercase letters, digits and _ (up to 32).`,
        );
        continue;
      }
      out.push({ name, source, file, def });
    }
    return out;
  };

  const user = await read("user", join(home, MCP_FILE));
  const project = home === root ? [] : await read("project", join(root, MCP_FILE));
  const userNames = new Set(user.map((s) => s.name));
  for (const s of project) {
    if (userNames.has(s.name)) {
      problems.push(
        `${s.file}: server "${s.name}" is ignored: a server with this name is in your own ${join("~", MCP_FILE)}.`,
      );
    }
  }
  return { servers: [...user, ...project.filter((s) => !userNames.has(s.name))], problems };
}

/** A stable hash of what the server will run and may do. Consent is pinned to it. */
export function defHash(def: ServerDef): string {
  const canonical = JSON.stringify({
    command: def.command,
    args: def.args,
    env: Object.fromEntries(Object.entries(def.env).sort(([a], [b]) => a.localeCompare(b))),
    network: def.network,
    writePaths: def.writePaths,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Fill `${NAME}` references from `source`. Missing variables become empty and are reported. */
export function expandEnv(
  env: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env,
): { env: Record<string, string>; missing: string[] } {
  const missing: string[] = [];
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      const v = source[name];
      if (v === undefined) missing.push(name);
      return v ?? "";
    });
  }
  return { env: out, missing };
}

/** The full command line, quoted, for the consent prompt. Never cut. */
export function commandLine(def: ServerDef): string {
  const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);
  return [def.command, ...def.args].map(quote).join(" ");
}
