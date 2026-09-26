import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { cleanText } from "./sanitize.js";

/**
 * OAuth for remote MCP servers (0.4). The MCP SDK runs the protocol (discovery, dynamic client
 * registration, authorization code with PKCE, refresh); Garuda gives it:
 * - AuthStore: ~/.garuda/mcp-auth.json (0600, written atomically): per server the registered
 *   client, the tokens and the callback port. Only in the home folder; never in session files.
 * - GarudaOAuthProvider: the SDK's OAuthClientProvider over that store.
 * - waitForCallback: a one-shot HTTP server on 127.0.0.1 that receives the browser's redirect and
 *   checks `state`.
 */

export const AUTH_FILE = join(".garuda", "mcp-auth.json");
/** The user has this long to sign in in the browser. */
export const SIGN_IN_TIMEOUT_MS = 300_000;

const entrySchema = z.object({
  client: z.record(z.string(), z.unknown()).optional(),
  tokens: z.record(z.string(), z.unknown()).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
});
const fileSchema = z.object({
  version: z.literal(1),
  servers: z.record(z.string(), entrySchema).default({}),
});
type AuthEntry = z.infer<typeof entrySchema>;

export class AuthStore {
  private data: z.infer<typeof fileSchema> = { version: 1, servers: {} };

  private constructor(readonly file: string) {}

  static async open(home: string = homedir()): Promise<AuthStore> {
    const store = new AuthStore(join(home, AUTH_FILE));
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(store.file, "utf8")));
      // A broken file holds no tokens: servers sign in again.
      if (parsed.success) store.data = parsed.data;
    } catch {
      // Missing or unreadable: start empty.
    }
    return store;
  }

  get(key: string): AuthEntry {
    return this.data.servers[key] ?? {};
  }

  async update(key: string, patch: Partial<Record<keyof AuthEntry, unknown>>): Promise<void> {
    const next: Record<string, unknown> = { ...this.get(key) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    this.data.servers[key] = next as AuthEntry;
    await this.save();
  }

  /** Remove every entry of a server (all scopes and URLs). Returns how many were removed. */
  async remove(server: string): Promise<number> {
    const keys = Object.keys(this.data.servers).filter((k) => k.split("::")[1] === server);
    for (const k of keys) delete this.data.servers[k];
    if (keys.length > 0) await this.save();
    return keys.length;
  }

  hasTokens(key: string): boolean {
    return this.get(key).tokens !== undefined;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, this.file);
  }
}

/** The store key of one server: its scope ("~" or the project root), name and URL. */
export function authKey(scope: string, name: string, url: string): string {
  return `${scope}::${name}::${url}`;
}

export class GarudaOAuthProvider implements OAuthClientProvider {
  /** Set by the SDK when the user must sign in. */
  authorizationUrl: URL | undefined;
  private verifier: string | undefined;
  private expectedState: string | undefined;

  constructor(
    private readonly store: AuthStore,
    private readonly key: string,
    readonly port: number,
  ) {}

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Garuda",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    } as OAuthClientMetadata;
  }

  state(): string {
    this.expectedState = randomBytes(16).toString("hex");
    return this.expectedState;
  }

  get stateValue(): string | undefined {
    return this.expectedState;
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.store.get(this.key).client as StoredOAuthClientInformation | undefined;
  }

  async saveClientInformation(info: StoredOAuthClientInformation): Promise<void> {
    await this.store.update(this.key, { client: info, port: this.port });
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.store.get(this.key).tokens as StoredOAuthTokens | undefined;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.store.update(this.key, { tokens });
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (this.verifier === undefined)
      throw new Error("No PKCE code verifier: start the sign-in again.");
    return this.verifier;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "verifier" || scope === "all") this.verifier = undefined;
    if (scope === "tokens" || scope === "all")
      await this.store.update(this.key, { tokens: undefined });
    if (scope === "client" || scope === "all")
      await this.store.update(this.key, { client: undefined });
  }
}

/** A free port on 127.0.0.1, for the callback of a new client registration. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

export class CallbackError extends Error {}

/**
 * Listen on 127.0.0.1:<port> for the browser's redirect. `listening` resolves when the server is
 * up (it rejects with EADDRINUSE when the port is taken); `result` resolves with the callback's
 * query when its `state` matches.
 */
export function waitForCallback(
  port: number,
  expectedState: () => string | undefined,
  signal: AbortSignal,
): { listening: Promise<void>; result: Promise<URLSearchParams> } {
  let server: Server | undefined;
  let settle: { resolve: (p: URLSearchParams) => void; reject: (e: unknown) => void } | undefined;
  const result = new Promise<URLSearchParams>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const finish = (fn: () => void) => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    server?.close();
    fn();
  };
  const onAbort = () => finish(() => settle?.reject(signal.reason));
  const timer = setTimeout(
    () =>
      finish(() =>
        settle?.reject(
          new CallbackError(`No sign-in within ${SIGN_IN_TIMEOUT_MS / 60_000} minutes.`),
        ),
      ),
    SIGN_IN_TIMEOUT_MS,
  );
  signal.addEventListener("abort", onAbort, { once: true });
  const listening = new Promise<void>((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const params = url.searchParams;
      const ok = params.get("state") !== null && params.get("state") === expectedState();
      res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      res.end(
        ok && params.has("code")
          ? "<p>Signed in. You can close this tab and go back to Garuda.</p>"
          : "<p>The sign-in did not work. Go back to Garuda.</p>",
      );
      if (!ok) {
        // A request without our state is not the answer to our sign-in: ignore it and keep waiting.
        return;
      }
      if (!params.has("code")) {
        // Only the short error code; the description is server text.
        const code = cleanText(params.get("error") ?? "no code").slice(0, 40);
        finish(() => settle?.reject(new CallbackError(`The sign-in failed (${code}).`)));
        return;
      }
      finish(() => settle?.resolve(params));
    });
    server.once("error", (error) => {
      finish(() => settle?.reject(error));
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });
  // A failed listen rejects both; the caller handles `listening`.
  result.catch(() => {});
  return { listening, result };
}
