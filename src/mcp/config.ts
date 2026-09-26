import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { checkAddress, isIpLiteral, isLoopbackHost } from "../net/address.js";

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
 * `${NAME}` in an env value takes NAME from Garuda's environment. Garuda passes no other
 * variables than its normal allowlist and these.
 *
 * Remote servers (0.4) use Streamable HTTP, with OAuth when the server asks for it:
 *     "linear": { "url": "https://mcp.linear.app/mcp" }
 * https only; http only for localhost in the user's own file. A project file may define them too
 * (with consent, pinned to the URL), but Garuda connects only to public addresses for those.
 */

export const MCP_FILE = join(".garuda", "mcp.json");

/** Server names become part of tool names: mcp__<server>__<tool>. */
export const SERVER_NAME = /^[a-z0-9][a-z0-9_]{0,31}$/;

const stdioSchema = z.strictObject({
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

const httpSchema = z.strictObject({
  type: z.literal("http").optional(),
  url: z.string().min(1),
  /** Time limit for one tool call. */
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
  enabled: z.boolean().default(true),
});

const serverSchema = z.union([httpSchema, stdioSchema]);

const fileSchema = z.strictObject({
  servers: z.record(z.string(), serverSchema).default({}),
});

export type StdioDef = z.infer<typeof stdioSchema>;
export type HttpDef = z.infer<typeof httpSchema>;
export type ServerDef = StdioDef | HttpDef;

/** True for a remote (Streamable HTTP) server. */
export function isHttp(def: ServerDef): def is HttpDef {
  return "url" in def;
}
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
      if (isHttp(def)) {
        const problem = checkServerUrl(def.url, source);
        if (problem !== undefined) {
          problems.push(`${file}: server "${name}": ${problem}`);
          continue;
        }
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

/**
 * The rules for a remote server's URL: https (http only for localhost in the user's own file), no
 * user:password, no fragment. A project server must use a host name or a public address; its
 * addresses are checked again at each connection (src/net/pinnedFetch.ts).
 */
export function checkServerUrl(raw: string, source: ServerSource): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw.slice(0, 200)}" is not a valid URL.`;
  }
  if (url.username !== "" || url.password !== "")
    return "a URL with a user name or password is not allowed.";
  if (url.hash !== "") return "a URL with a #fragment is not allowed.";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = isLoopbackHost(host);
  if (url.protocol === "http:") {
    if (!loopback || source === "project")
      return "use https (http only for localhost, in your own ~/.garuda/mcp.json).";
  } else if (url.protocol !== "https:") {
    return `only https URLs are allowed, not ${url.protocol}`;
  }
  if (source === "project" && (loopback || (isIpLiteral(host) && !checkAddress(host, false).ok))) {
    return "a project server must be on a public address.";
  }
  return undefined;
}

/** A stable hash of what the server will run and may do. Consent is pinned to it. */
export function defHash(def: ServerDef): string {
  if (isHttp(def)) {
    return createHash("sha256")
      .update(JSON.stringify({ type: "http", url: def.url }))
      .digest("hex");
  }
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
export function commandLine(def: StdioDef): string {
  const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);
  return [def.command, ...def.args].map(quote).join(" ");
}
