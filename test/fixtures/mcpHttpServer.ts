import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * A remote MCP server for tests (0.4): Streamable HTTP (stateless) on 127.0.0.1, and with
 * `oauth: true` a small OAuth 2.1 authorization server in the same process: protected resource
 * metadata, authorization server metadata, dynamic client registration, /authorize (it redirects at
 * once, like a user who agreed) and /token with PKCE (S256) and refresh.
 */

export interface HttpFixture {
  url: string;
  origin: string;
  close(): Promise<void>;
  /** What happened, for assertions. */
  log: string[];
  /** Change the next /authorize redirect: a wrong state, or an error. */
  authorizeMode: "ok" | "wrong-state" | "error";
  /** Forget every access token (they "expired"); refresh tokens still work. */
  expireTokens(): void;
}

export async function startHttpFixture(options: { oauth: boolean }): Promise<HttpFixture> {
  const log: string[] = [];
  const codes = new Map<string, { challenge: string; clientId: string }>();
  const tokens = new Set<string>();
  let clients = 0;
  const fixture: HttpFixture = {
    url: "",
    origin: "",
    log,
    authorizeMode: "ok",
    close: async () => {},
    expireTokens: () => tokens.clear(),
  };

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", fixture.origin);
      if (url.pathname === "/mcp") return await mcp(req, res);
      if (!options.oauth) return send(res, 404, "not found");
      switch (url.pathname) {
        case "/.well-known/oauth-protected-resource":
        case "/.well-known/oauth-protected-resource/mcp":
          return json(res, 200, {
            resource: fixture.url,
            authorization_servers: [fixture.origin],
          });
        case "/.well-known/oauth-authorization-server":
          return json(res, 200, {
            issuer: fixture.origin,
            authorization_endpoint: `${fixture.origin}/authorize`,
            token_endpoint: `${fixture.origin}/token`,
            registration_endpoint: `${fixture.origin}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
        case "/register": {
          const body = JSON.parse(await text(req)) as Record<string, unknown>;
          clients++;
          log.push(`register ${JSON.stringify(body.redirect_uris)}`);
          return json(res, 201, { ...body, client_id: `client-${clients}` });
        }
        case "/authorize": {
          const p = url.searchParams;
          if (p.get("code_challenge_method") !== "S256") return send(res, 400, "no pkce");
          const code = randomBytes(8).toString("hex");
          codes.set(code, {
            challenge: p.get("code_challenge") ?? "",
            clientId: p.get("client_id") ?? "",
          });
          log.push("authorize");
          const back = new URL(p.get("redirect_uri") ?? "");
          if (fixture.authorizeMode === "error") {
            back.searchParams.set("error", "access_denied");
          } else {
            back.searchParams.set("code", code);
          }
          back.searchParams.set(
            "state",
            fixture.authorizeMode === "wrong-state" ? "not-yours" : (p.get("state") ?? ""),
          );
          res.writeHead(302, { location: back.toString() }).end();
          return;
        }
        case "/token": {
          const form = new URLSearchParams(await text(req));
          if (form.get("grant_type") === "refresh_token") {
            log.push("refresh");
            return json(res, 200, issue());
          }
          const entry = codes.get(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (entry === undefined || entry.challenge !== challenge) {
            log.push("token rejected");
            return json(res, 400, { error: "invalid_grant" });
          }
          codes.delete(form.get("code") ?? "");
          log.push("token");
          return json(res, 200, issue());
        }
        default:
          return send(res, 404, "not found");
      }
    } catch (error) {
      send(res, 500, String(error));
    }
  });

  function issue() {
    const access = randomBytes(8).toString("hex");
    tokens.add(access);
    return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: "r1" };
  }

  async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (options.oauth) {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (bearer === undefined || !tokens.has(bearer)) {
        log.push("401");
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${fixture.origin}/.well-known/oauth-protected-resource/mcp"`,
        });
        res.end();
        return;
      }
    }
    const mcpServer = new McpServer({ name: "http-fixture", version: "1.0.0" });
    mcpServer.registerTool(
      "echo",
      { description: "Echo text back.", inputSchema: z.object({ text: z.string() }) },
      async ({ text: t }) => ({ content: [{ type: "text", text: `remote echo: ${t}` }] }),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcpServer.connect(transport);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await text(req);
    const request = new Request(new URL(req.url ?? "/", fixture.origin), {
      method: req.method ?? "GET",
      headers: Object.entries(req.headers).flatMap(([k, v]) =>
        v === undefined ? [] : [[k, Array.isArray(v) ? v.join(", ") : v] as [string, string]],
      ),
      ...(body === undefined ? {} : { body }),
    });
    const response = await transport.handleRequest(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body === null) {
      res.end();
      return;
    }
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res);
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  fixture.origin = `http://127.0.0.1:${port}`;
  fixture.url = `${fixture.origin}/mcp`;
  fixture.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fixture;
}

function text(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      body += c;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain" }).end(body);
}
