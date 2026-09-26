import { type CallToolResult, Client, type Tool as McpTool } from "@modelcontextprotocol/client";
import { pinnedFetch } from "../net/pinnedFetch.js";
import { DEFAULT_ENV_ALLOWLIST } from "../permissions/engine.js";
import { type SandboxSettings, sandboxPaths } from "../permissions/sandboxPaths.js";
import type { ApprovalRequest, Approver } from "../permissions/types.js";
import type { ExecPolicy, Executor } from "../sandbox/types.js";
import type { AnyTool } from "../tools/types.js";
import { VERSION } from "../version.js";
import {
  commandLine,
  defHash,
  expandEnv,
  type HttpDef,
  isHttp,
  type ServerConfig,
  type StdioDef,
} from "./config.js";
import { connectHttp } from "./http.js";
import { type AuthStore, authKey } from "./oauth.js";
import { cleanText } from "./sanitize.js";
import { perToolHashes, type ToolChanges, toGarudaTools, toolChanges, toolsHash } from "./tools.js";
import { ProcessTransport } from "./transport.js";
import { type TrustStore, USER_SCOPE } from "./trust.js";

/** Time to start a server and list its tools. */
export const CONNECT_TIMEOUT_MS = 30_000;

export type McpState = "connected" | "failed" | "denied" | "disabled" | "stopped";

export interface McpServerStatus {
  name: string;
  source: ServerConfig["source"];
  state: McpState;
  tools: number;
  sandboxed: boolean;
  network: boolean;
  /** stdio: a local program in the sandbox; http: a remote server (0.4). */
  transport: "stdio" | "http";
  /** http: the server's URL, and whether Garuda holds tokens for it. */
  url?: string;
  signedIn?: boolean;
  message?: string;
}

export interface McpManagerOptions {
  root: string;
  executor: Executor;
  approver: Approver;
  trust: TrustStore;
  sandbox?: SandboxSettings;
  env?: NodeJS.ProcessEnv;
  /** Warnings for the user (missing env vars, changed tools, failed servers). */
  notify?: (text: string) => void;
  /** OAuth tokens of remote servers (0.4). Default: ~/.garuda/mcp-auth.json, opened on first use. */
  auth?: AuthStore;
  /** For tests: open the sign-in page. Default: the system browser. */
  openBrowser?: (url: URL) => Promise<void>;
}

interface Connection {
  config: ServerConfig;
  client: Client;
  transport: { onclose?: (() => void) | undefined };
}

/**
 * Starts the configured MCP servers (stdio, in the OS sandbox), asks for consent where needed,
 * and calls their tools. Security rules (0.2):
 * - A project server runs only after the user saw the full command, its sandbox, network and
 *   env, and agreed. The consent is pinned to a hash of the definition.
 * - A change in a server's tool list after approval is reported; a project server needs consent again.
 * - Garuda offers no client capabilities: servers cannot ask for sampling, roots or elicitation.
 * - The tool list is read once per session. Later list_changed notifications are ignored.
 */
export class McpManager {
  private readonly connections = new Map<string, Connection>();
  private readonly statuses = new Map<string, McpServerStatus>();
  /** The state the model was last told about, per server. */
  private readonly announced = new Map<string, McpState>();

  constructor(private readonly options: McpManagerOptions) {}

  /** Start every enabled server. Returns the tools of the servers that connected. */
  async start(configs: readonly ServerConfig[], signal: AbortSignal): Promise<AnyTool[]> {
    const tools: AnyTool[] = [];
    for (const config of configs) {
      if (signal.aborted) break;
      try {
        tools.push(...(await this.startOne(config, signal)));
      } catch (error) {
        if (signal.aborted) throw error;
        const message = cleanText((error as Error).message).slice(0, 300);
        this.setStatus(config, "failed", 0, message);
        this.notify(`MCP server "${config.name}" did not start: ${message}`);
      }
    }
    return tools;
  }

  status(): McpServerStatus[] {
    return [...this.statuses.values()];
  }

  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const connection = this.connections.get(server);
    if (connection === undefined) throw new Error(`MCP server "${server}" is not running.`);
    const result = await connection.client.callTool(
      { name: tool, arguments: args },
      { signal, timeout: connection.config.def.timeoutMs },
    );
    return result as CallToolResult;
  }

  async close(): Promise<void> {
    // Clear first: a closed transport calls onclose, and a planned stop is not a failure to report.
    const open = [...this.connections.values()];
    this.connections.clear();
    for (const { client, config } of open) {
      await client.close().catch(() => {});
      this.setStatus(config, "stopped", 0);
    }
  }

  private async startOne(config: ServerConfig, signal: AbortSignal): Promise<AnyTool[]> {
    const { def, name, source } = config;
    if (!def.enabled) {
      this.setStatus(config, "disabled", 0);
      return [];
    }
    const scope = source === "user" ? USER_SCOPE : this.options.root;
    const trusted = this.options.trust.get(scope, name);
    const hash = defHash(def);

    let remember = source === "user";
    if (source === "project" && trusted.def !== hash) {
      const choice = await this.options.approver.ask(
        this.consentRequest(config, trusted.def),
        signal,
      );
      if (choice === "deny") {
        this.setStatus(config, "denied", 0, "you did not allow it");
        return [];
      }
      remember = choice === "session";
      if (remember) await this.options.trust.set(scope, name, { def: hash });
    }

    const { client, transport, serverTools } = isHttp(def)
      ? await this.connectRemote({ ...config, def }, scope, signal)
      : await this.connectLocal({ ...config, def }, signal);

    const toolHash = toolsHash(serverTools);
    if (trusted.tools !== undefined && trusted.tools !== toolHash) {
      const changes =
        trusted.toolHashes === undefined ? undefined : toolChanges(trusted.toolHashes, serverTools);
      if (source === "project") {
        const choice = await this.options.approver.ask(
          this.changedToolsRequest(config, serverTools, changes),
          signal,
        );
        if (choice === "deny") {
          await client.close().catch(() => {});
          this.setStatus(config, "denied", 0, "its tools changed and you did not allow them");
          return [];
        }
        remember = choice === "session";
      } else {
        const what = changes === undefined ? "" : ` (${changeSummary(changes)})`;
        this.notify(`MCP server "${name}": its tools changed since the last session${what}.`);
      }
    }
    // An entry from before per-tool hashes, for the same approved list: add them now.
    const backfill = trusted.tools === toolHash && trusted.toolHashes === undefined;
    if (remember || backfill) {
      await this.options.trust.set(scope, name, {
        tools: toolHash,
        toolHashes: perToolHashes(serverTools),
      });
    }

    const { tools, problems } = toGarudaTools(name, serverTools, this);

    for (const problem of problems) this.notify(`MCP server "${name}": ${problem}.`);
    this.connections.set(name, { config, client, transport });
    transport.onclose = () => {
      if (this.connections.delete(name)) {
        this.setStatus(config, "failed", 0, "the server stopped");
        this.notify(`MCP server "${name}" stopped. Its tools now fail.`);
      }
    };
    this.setStatus(config, "connected", tools.length);
    return tools;
  }

  /** A local server: the program in the OS sandbox, over stdio. */
  private async connectLocal(
    config: ServerConfig & { def: StdioDef },
    signal: AbortSignal,
  ): Promise<{ client: Client; transport: ProcessTransport; serverTools: McpTool[] }> {
    const { def, name } = config;
    const { env, missing } = expandEnv(def.env, this.options.env);
    if (missing.length > 0) {
      this.notify(
        `MCP server "${name}": ${missing.map((m) => `$${m}`).join(", ")} is not set, so it gets an empty value.`,
      );
    }
    const process = this.options.executor.start(
      [def.command, ...def.args],
      this.policy(config),
      env,
    );
    const transport = new ProcessTransport(process);
    const client = new Client(
      { name: "garuda", version: VERSION },
      // No capabilities: no sampling, no roots, no elicitation.
      { capabilities: {}, versionNegotiation: { mode: "auto" } },
    );
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]);
    try {
      await withSignal(client.connect(transport), timeout);
      return { client, transport, serverTools: await withSignal(listAllTools(client), timeout) };
    } catch (error) {
      await client.close().catch(() => {});
      const stderr = transport.lastStderr().slice(-3).join(" | ");
      const why =
        timeout.aborted && !signal.aborted ? "no answer in 30 s" : (error as Error).message;
      throw new Error(stderr === "" ? why : `${why} (server said: ${stderr})`);
    }
  }

  /** A remote server over Streamable HTTP, with OAuth when it asks (0.4). */
  private async connectRemote(
    config: ServerConfig & { def: HttpDef },
    scope: string,
    signal: AbortSignal,
  ) {
    const auth = await this.authStore();
    const { client, transport } = await connectHttp(
      config,
      {
        scope,
        auth,
        approver: this.options.approver,
        executor: this.options.executor,
        notify: (t) => this.notify(t),
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        // A project's server: only public addresses, checked at each request.
        ...(config.source === "project" ? { fetch: pinnedFetch() } : {}),
        ...(this.options.openBrowser === undefined
          ? {}
          : { openBrowser: this.options.openBrowser }),
      },
      signal,
    );
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]);
    try {
      return { client, transport, serverTools: await withSignal(listAllTools(client), timeout) };
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  private auth: AuthStore | undefined;

  private async authStore(): Promise<AuthStore> {
    if (this.options.auth !== undefined) return this.options.auth;
    const { AuthStore } = await import("./oauth.js");
    this.auth ??= await AuthStore.open();
    return this.auth;
  }

  /** /mcp logout: forget the tokens and the client registration of a remote server. */
  async logout(server: string): Promise<number> {
    return (await this.authStore()).remove(server);
  }

  private policy(config: ServerConfig & { def: StdioDef }): ExecPolicy {
    const { root, sandbox = {} } = this.options;
    const paths = sandboxPaths(root, {
      ...sandbox,
      writePaths: [...(sandbox.writePaths ?? []), ...config.def.writePaths],
    });
    return {
      root,
      sandbox: true,
      ...paths,
      network: config.def.network,
      envAllowlist: [...DEFAULT_ENV_ALLOWLIST],
      timeoutMs: 0,
      maxOutputBytes: 0,
    };
  }

  private consentRequest(config: ServerConfig, previous: string | undefined): ApprovalRequest {
    const { def, name, file } = config;
    const isolation = this.options.executor.isolation;
    const labels = {
      once: "Yes, for this session only",
      session: "Yes, and remember (asks again if the config changes)",
      deny: previous === undefined && isHttp(def) ? "No, do not connect" : "No, do not start it",
    };
    if (isHttp(def)) {
      const lines = [
        previous === undefined
          ? `This project wants to connect to MCP server "${name}" (from ${file}).`
          : `MCP server "${name}" in ${file} changed since you allowed it.`,
        "It is a remote server:",
        `  URL: ${cleanText(def.url)}`,
        "  Garuda connects from its own process (not the sandbox), only to public addresses.",
        "  ! The server gets the arguments of every call to its tools: that data leaves this machine.",
        "  ! It may ask you to sign in; then it acts with your account.",
        "Allow it only if you trust this project and this server.",
      ];
      return {
        tool: "mcp",
        target: { kind: "input", json: JSON.stringify({ server: name }) },
        preview: lines.join("\n"),
        isolation,
        title: `Connect to MCP server "${name}"?`,
        labels,
      };
    }
    const envNames = Object.entries(def.env).map(([k, v]) => {
      const refs = [...v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => `$${m[1]}`);
      return refs.length > 0 ? `${k} (from ${refs.join(", ")})` : `${k} (a fixed value)`;
    });
    const lines = [
      previous === undefined
        ? `This project wants to start MCP server "${name}" (from ${file}).`
        : `MCP server "${name}" in ${file} changed since you allowed it.`,
      "It runs this program:",
      `  $ ${commandLine(def)}`,
      isolation === "none"
        ? "  Sandbox: NONE. It runs as you, with full access to your files."
        : `  Sandbox: ${this.options.executor.name}. It can read your files (not ~/.ssh and other secrets) and write only in this project and temp folders.`,
      `  Network: ${def.network ? "YES" : "no"}`,
      ...(def.writePaths.length > 0 ? [`  Extra write paths: ${def.writePaths.join(", ")}`] : []),
      `  Environment: ${envNames.length > 0 ? envNames.join(", ") : "only the normal variables"}`,
      ...warnings({ ...config, def }, isolation === "none").map((w) => `  ! ${w}`),
      "Allow it only if you trust this project.",
    ];
    return {
      tool: "mcp",
      target: { kind: "input", json: JSON.stringify({ server: name }) },
      preview: lines.join("\n"),
      isolation,
      title: `Start MCP server "${name}"?`,
      labels,
    };
  }

  private changedToolsRequest(
    config: ServerConfig,
    tools: readonly McpTool[],
    changes: ToolChanges | undefined,
  ): ApprovalRequest {
    const lines = [
      `The tools of MCP server "${config.name}" changed since you allowed it.`,
      "A server that changes its tool descriptions can try to change what the model does.",
    ];
    if (changes === undefined) {
      const names = tools.map((t) => cleanText(t.name)).slice(0, 30);
      lines.push(`Tools now: ${names.join(", ")}${tools.length > names.length ? ", …" : ""}`);
    } else {
      lines.push(...changeLines(changes));
    }
    return {
      tool: "mcp",
      target: { kind: "input", json: JSON.stringify({ server: config.name }) },
      preview: lines.join("\n"),
      isolation: this.options.executor.isolation,
      title: `Use the changed tools of "${config.name}"?`,
      labels: {
        once: "Yes, for this session only",
        session: "Yes, and remember",
        deny: "No, stop this server",
      },
    };
  }

  /**
   * Notes for the model about servers that are not available, each told once per state.
   * Without them the model cannot know that a configured server is off, and it may guess.
   */
  takeNotes(): string[] {
    const notes: string[] = [];
    for (const status of this.statuses.values()) {
      if (this.announced.get(status.name) === status.state) continue;
      const wasTold = this.announced.has(status.name);
      this.announced.set(status.name, status.state);
      if (status.state === "connected") {
        if (wasTold) notes.push(`MCP server "${status.name}" is available again.`);
        continue;
      }
      const why = status.message ?? status.state;
      notes.push(
        `MCP server "${status.name}" is not available (${why}). Its tools are not in your tool list. Do not pretend to use it, and do not present other results as its results. If the task needs it, tell the user.`,
      );
    }
    return notes;
  }

  private setStatus(config: ServerConfig, state: McpState, tools: number, message?: string): void {
    const { def } = config;
    const remote = isHttp(def);
    const scope = config.source === "user" ? USER_SCOPE : this.options.root;
    this.statuses.set(config.name, {
      name: config.name,
      source: config.source,
      state,
      tools,
      sandboxed: !remote && this.options.executor.isolation !== "none",
      network: remote || def.network,
      transport: remote ? "http" : "stdio",
      ...(remote
        ? {
            url: def.url,
            signedIn:
              (this.options.auth ?? this.auth)?.hasTokens(
                authKey(scope, config.name, new URL(def.url).toString()),
              ) ?? false,
          }
        : {}),
      ...(message === undefined ? {} : { message }),
    });
  }

  private notify(text: string): void {
    this.options.notify?.(text);
  }
}

const MAX_LISTED = 10;
const quoteDescription = (tool: McpTool) =>
  `"${cleanText(tool.description ?? "")
    .replace(/\s+/g, " ")
    .slice(0, 300)}"`;

/** The lines that say what changed, with the new descriptions (cleaned). */
export function changeLines(changes: ToolChanges): string[] {
  const lines: string[] = [];
  for (const { tool, description, schema } of changes.changed.slice(0, MAX_LISTED)) {
    const parts = [description ? "description" : "", schema ? "input schema" : ""].filter(Boolean);
    lines.push(`Changed: ${cleanText(tool.name)} (${parts.join(" and ")})`);
    if (description) lines.push(`  new description: ${quoteDescription(tool)}`);
  }
  for (const tool of changes.added.slice(0, MAX_LISTED)) {
    lines.push(`Added: ${cleanText(tool.name)}`);
    lines.push(`  description: ${quoteDescription(tool)}`);
  }
  if (changes.removed.length > 0) {
    lines.push(`Removed: ${changes.removed.map(cleanText).join(", ")}`);
  }
  const more =
    Math.max(0, changes.changed.length - MAX_LISTED) +
    Math.max(0, changes.added.length - MAX_LISTED);
  if (more > 0) lines.push(`… and ${more} more`);
  return lines;
}

function changeSummary(changes: ToolChanges): string {
  const parts = [
    changes.changed.length > 0
      ? `changed: ${changes.changed.map((c) => c.tool.name).join(", ")}`
      : "",
    changes.added.length > 0 ? `added: ${changes.added.map((t) => t.name).join(", ")}` : "",
    changes.removed.length > 0 ? `removed: ${changes.removed.join(", ")}` : "",
  ].filter(Boolean);
  return cleanText(parts.join("; ")).slice(0, 300);
}

/** Patterns in a server command that deserve a warning in the consent prompt. */
export function warnings(config: ServerConfig & { def: StdioDef }, noSandbox: boolean): string[] {
  const { def } = config;
  const line = commandLine(def);
  const out: string[] = [];
  if (noSandbox)
    out.push("There is no OS sandbox on this machine: the server can do anything you can.");
  if (/(^|\s)(npx|bunx|uvx|pipx|dlx)(\s|$)|pnpm\s+dlx/.test(line)) {
    out.push(
      "It downloads and runs a package when it starts. Pin a version (for example pkg@1.2.3).",
    );
  }
  if (/(^|\s)(bash|sh|zsh)\s+-c|curl|wget|\|\s*(sh|bash)/.test(line)) {
    out.push("It runs a shell command or downloads something. Read it carefully.");
  }
  if (/(^|\s)sudo(\s|$)|rm\s+-rf/.test(line)) out.push("It uses sudo or rm -rf.");
  if (def.network) out.push("It may send data over the network.");
  const secret = Object.keys(def.env).filter((k) => /KEY|TOKEN|SECRET|PASS|CRED/i.test(k));
  if (secret.length > 0) out.push(`It gets secrets: ${secret.join(", ")}.`);
  return out;
}

async function listAllTools(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await client.listTools(cursor === undefined ? {} : { cursor });
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (cursor === undefined || tools.length > 1_000) break;
  }
  return tools;
}

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
