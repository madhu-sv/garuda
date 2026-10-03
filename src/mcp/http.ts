import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { isLoopbackHost } from "../net/address.js";
import type { ApprovalRequest, Approver } from "../permissions/types.js";
import type { Executor } from "../sandbox/types.js";
import { VERSION } from "../version.js";
import type { HttpDef, ServerConfig } from "./config.js";
import {
  type AuthStore,
  authKey,
  CallbackError,
  freePort,
  GarudaOAuthProvider,
  waitForCallback,
} from "./oauth.js";
import { cleanLine, cleanText } from "./sanitize.js";

/**
 * Connect to a remote MCP server over Streamable HTTP (0.4). When the server answers 401, the SDK
 * prepares an OAuth sign-in; Garuda asks the user, opens the browser, waits for the callback on
 * 127.0.0.1, finishes the sign-in and connects again. Project servers use a fetch that connects
 * only to public addresses.
 */

export interface HttpConnectOptions {
  scope: string;
  auth: AuthStore;
  approver: Approver;
  executor: Executor;
  notify: (text: string) => void;
  /** Only for project servers: the address-checking fetch (src/net/pinnedFetch.ts). */
  fetch?: typeof fetch;
  /** Opens the sign-in page. Default: the system browser, through the Executor. Tests replace it. */
  openBrowser?: (url: URL) => Promise<void>;
  connectTimeoutMs: number;
}

export interface HttpConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

export class SignInSkipped extends Error {}

export async function connectHttp(
  config: ServerConfig & { def: HttpDef },
  options: HttpConnectOptions,
  signal: AbortSignal,
): Promise<HttpConnection> {
  const url = new URL(config.def.url);
  const key = authKey(options.scope, config.name, url.toString());
  // Two rounds: connect (maybe sign in), then connect with the new tokens. One more round when the
  // callback port of an earlier registration is taken now.
  for (let round = 0; round < 3; round++) {
    let port = options.auth.get(key).port;
    if (port === undefined) {
      port = await freePort();
      await options.auth.update(key, { port });
    }
    const provider = new GarudaOAuthProvider(options.auth, key, port);
    const transport = new StreamableHTTPClientTransport(url, {
      authProvider: provider,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const client = new Client(
      { name: "garuda", version: VERSION },
      // No capabilities: no sampling, no roots, no elicitation.
      { capabilities: {}, versionNegotiation: { mode: "auto" } },
    );
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(options.connectTimeoutMs)]);
    try {
      await abortable(client.connect(transport), timeout);
      return { client, transport };
    } catch (error) {
      if (signal.aborted) throw error;
      const needsSignIn =
        error instanceof UnauthorizedError || provider.authorizationUrl !== undefined;
      if (!needsSignIn || provider.authorizationUrl === undefined || round === 2) {
        await client.close().catch(() => {});
        if (timeout.aborted) throw new Error(`no answer in ${options.connectTimeoutMs / 1000} s`);
        throw error;
      }
    }

    // Sign in: ask, listen for the callback, open the browser, exchange the code.
    const authUrl = provider.authorizationUrl;
    // http only on this machine, and only for the user's own servers (0.14.1, review): a project
    // server could point the browser at a local service, with the browser's cookies for it.
    const loopbackOk =
      config.source === "user" && authUrl.protocol === "http:" && isLoopbackHost(authUrl.hostname);
    if (authUrl.protocol !== "https:" && !loopbackOk) {
      await client.close().catch(() => {});
      throw new Error(
        `the sign-in page is not https (${authUrl.protocol}); Garuda does not open it`,
      );
    }
    const choice = await options.approver.ask(
      signInQuestion(config, authUrl, provider.redirectUrl),
      signal,
    );
    if (choice === "deny") {
      await client.close().catch(() => {});
      throw new SignInSkipped("it needs a sign-in, and you skipped it");
    }
    const callback = waitForCallback(port, () => provider.stateValue, signal);
    try {
      await callback.listening;
    } catch (error) {
      await client.close().catch(() => {});
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      // The registered callback port is taken: register again with a new port.
      await options.auth.update(key, { client: undefined, port: undefined });
      continue;
    }
    options.notify(
      `Sign in to MCP server "${config.name}" in your browser. If it does not open, open this URL:\n${authUrl.toString()}`,
    );
    await (options.openBrowser ?? ((u) => openInBrowser(u, options.executor)))(authUrl).catch(
      () => {},
    );
    try {
      const params = await callback.result;
      await transport.finishAuth(params);
    } catch (error) {
      await client.close().catch(() => {});
      if (error instanceof CallbackError) throw error;
      if (signal.aborted) throw error;
      throw new Error(`the sign-in failed: ${cleanText((error as Error).message).slice(0, 200)}`);
    }
    await client.close().catch(() => {});
  }
  throw new Error("the sign-in did not complete");
}

function signInQuestion(
  config: ServerConfig & { def: HttpDef },
  authUrl: URL,
  redirect: string,
): ApprovalRequest {
  return {
    tool: "mcp",
    target: { kind: "input", json: JSON.stringify({ server: config.name }) },
    preview: [
      `MCP server "${config.name}" (${cleanLine(config.def.url)}) asks you to sign in.`,
      `Garuda opens your browser at ${authUrl.origin}. After the sign-in, the browser returns to`,
      `${redirect}. The tokens stay in ~/.garuda/mcp-auth.json (only you can read it).`,
    ].join("\n"),
    isolation: "none",
    title: `Sign in to "${config.name}"?`,
    question: "Sign in now?",
    choices: ["once", "deny"],
    labels: { once: "Yes, open the browser", deny: "No, skip this server" },
  };
}

/** Open a URL in the system browser, through the Executor (N8). */
export async function openInBrowser(url: URL, executor: Executor): Promise<void> {
  const program =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const quoted = `'${url.toString().replaceAll("'", "'\\''")}'`;
  await executor.run(`${program} ${quoted}`, {
    root: process.cwd(),
    sandbox: false,
    writePaths: [],
    denyWritePaths: [],
    denyReadPaths: [],
    network: true,
    envAllowlist: [
      "PATH",
      "HOME",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
    ],
    timeoutMs: 10_000,
    maxOutputBytes: 2_000,
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
