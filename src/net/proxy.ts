import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAddress, isIpLiteral } from "./address.js";
import { defaultResolve, type Resolver } from "./pinnedFetch.js";

/**
 * The network proxy for commands in the sandbox (0.13, W6). Commands get HTTP_PROXY and
 * HTTPS_PROXY that point here; the sandbox lets them reach only this proxy. It does not look into
 * TLS: for https it sees the host of the CONNECT request, asks `decide`, and then joins the two
 * sockets. The host must resolve to public addresses only, and the connection goes to the address
 * that was checked (no DNS rebinding to a private address).
 *
 * It listens on 127.0.0.1 (Seatbelt allows localhost) and on a Unix socket (bubblewrap has its own
 * network namespace; a small bridge inside it forwards a local port to the socket).
 */

export interface ProxyDecision {
  allowed: boolean;
  /** Why not, for the command's error text. */
  reason?: string;
}

export interface NetworkProxyOptions {
  /** Is this host and port allowed? May ask the user; it runs while the command waits. */
  decide: (host: string, port: number) => Promise<ProxyDecision>;
  resolve?: Resolver;
  /** Which resolved addresses are allowed. Default: public unicast only (tests allow loopback). */
  addressAllowed?: (address: string) => boolean;
}

/** A host that was blocked, for the model's hint after the command. */
export interface BlockedHost {
  host: string;
  port: number;
  reason: string;
}

export class NetworkProxy {
  private readonly servers: Server[] = [];
  private readonly sockets = new Set<Socket>();
  private blocked: BlockedHost[] = [];
  private dir: string | undefined;
  port = 0;
  socketPath = "";

  constructor(private readonly options: NetworkProxyOptions) {}

  async start(): Promise<{ port: number; socketPath: string }> {
    this.dir = mkdtempSync(join(tmpdir(), "garuda-net-"));
    this.socketPath = join(this.dir, "proxy.sock");
    const tcp = this.server();
    const unix = this.server();
    await new Promise<void>((resolve, reject) => {
      tcp.once("error", reject);
      tcp.listen(0, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      unix.once("error", reject);
      unix.listen(this.socketPath, () => resolve());
    });
    const address = tcp.address();
    this.port = typeof address === "object" && address !== null ? address.port : 0;
    return { port: this.port, socketPath: this.socketPath };
  }

  /** The hosts blocked since the last call. */
  takeBlocked(): BlockedHost[] {
    const out = this.blocked;
    this.blocked = [];
    return out;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(
      this.servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    if (this.dir !== undefined) rmSync(this.dir, { recursive: true, force: true });
  }

  private server(): Server {
    const server = createServer((req, res) => {
      void this.forwardHttp(req, res);
    });
    server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
      void this.tunnel(req, client, head);
    });
    server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.servers.push(server);
    return server;
  }

  /** https: CONNECT host:port, then a raw tunnel. */
  private async tunnel(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    client.on("error", () => {});
    const target = parseAuthority(req.url ?? "");
    if (target === undefined) {
      refuse(client, 400, "Garuda's proxy: a CONNECT request needs host:port.");
      return;
    }
    const address = await this.check(target.host, target.port);
    if (typeof address !== "string") {
      refuse(client, 403, address.reason);
      return;
    }
    const upstream = connect(target.port, address);
    this.sockets.add(upstream);
    upstream.on("close", () => this.sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  }

  /** http: a request with an absolute URL. */
  private async forwardHttp(
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("Garuda's proxy: only absolute http URLs.\n");
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(400).end("Garuda's proxy: only http here; https goes through CONNECT.\n");
      return;
    }
    const port = url.port === "" ? 80 : Number(url.port);
    const address = await this.check(url.hostname, port);
    if (typeof address !== "string") {
      res.writeHead(403, { "content-type": "text/plain" }).end(`${address.reason}\n`);
      return;
    }
    const headers = { ...req.headers };
    for (const name of Object.keys(headers)) {
      if (name.startsWith("proxy-")) delete headers[name];
    }
    const upstream = httpRequest(
      {
        host: address,
        port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: url.host },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502).end("Garuda's proxy: the host did not answer.\n");
      else res.destroy();
    });
    req.pipe(upstream);
  }

  /** The checked address to connect to, or why not. */
  private async check(host: string, port: number): Promise<string | { reason: string }> {
    const block = (reason: string) => {
      this.blocked.push({ host, port, reason });
      return { reason };
    };
    const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
    if (isIpLiteral(bare)) {
      return block(`Garuda's network allowlist: use a host name, not the address ${bare}.`);
    }
    const decision = await this.options
      .decide(bare, port)
      .catch((): ProxyDecision => ({ allowed: false, reason: "the check failed" }));
    if (!decision.allowed) {
      return block(
        `Garuda's network allowlist blocked ${bare}:${port}${decision.reason === undefined ? "" : `: ${decision.reason}`}.`,
      );
    }
    let addresses: { address: string; family: number }[];
    try {
      addresses = await (this.options.resolve ?? defaultResolve)(bare);
    } catch {
      return block(`Garuda's proxy: ${bare} has no address.`);
    }
    const allowed = this.options.addressAllowed ?? ((a: string) => checkAddress(a, false).ok);
    if (addresses.length === 0 || !addresses.every((a) => allowed(a.address))) {
      return block(`Garuda's proxy: ${bare} does not resolve to public addresses only.`);
    }
    return (addresses[0] as { address: string }).address;
  }
}

/** "host:443" or "[::1]:443" → host and port. */
export function parseAuthority(text: string): { host: string; port: number } | undefined {
  const m = /^(\[[^\]]+\]|[^:/]+):(\d{1,5})$/.exec(text);
  if (m === null) return undefined;
  const port = Number(m[2]);
  if (port < 1 || port > 65_535) return undefined;
  return { host: (m[1] as string).replace(/^\[|\]$/g, ""), port };
}

function refuse(client: Socket, status: 400 | 403, text: string): void {
  const body = `${text}\n`;
  client.end(
    `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Request"}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  );
}
