import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  describeAllowlist,
  expandAllowlist,
  hostAllowed,
  NETWORK_PRESETS,
} from "../src/net/allowlist.js";
import { NetworkProxy, parseAuthority } from "../src/net/proxy.js";
import { BRIDGE_JS, bwrapArgs } from "../src/sandbox/bwrap.js";
import { findOsSandbox } from "../src/sandbox/index.js";
import { proxyEnv } from "../src/sandbox/process.js";
import type { ExecPolicy } from "../src/sandbox/types.js";

/** The network allowlist for sandboxed commands (0.13, W6). */

describe("the allowlist (0.13)", () => {
  it("expands presets and hosts, and names what is neither", () => {
    const { hosts, problems } = expandAllowlist([
      "npm",
      "PyPI",
      "api.example.com",
      "*.example.org",
    ]);
    expect(hosts).toEqual([
      ...(NETWORK_PRESETS.npm ?? []),
      ...(NETWORK_PRESETS.pypi ?? []),
      "api.example.com",
      "*.example.org",
    ]);
    expect(problems).toEqual([]);
    expect(expandAllowlist(["npmm", "http://x.com", "10.0.0.1", "*"]).problems).toHaveLength(4);
  });

  it("matches a host exactly, and *. only the subdomains", () => {
    const list = ["registry.npmjs.org", "*.example.org"];
    expect(hostAllowed("registry.npmjs.org", list)).toBe(true);
    expect(hostAllowed("REGISTRY.npmjs.org.", list)).toBe(true);
    expect(hostAllowed("evil-registry.npmjs.org", list)).toBe(false);
    expect(hostAllowed("a.b.example.org", list)).toBe(true);
    expect(hostAllowed("example.org", list)).toBe(false);
    expect(hostAllowed("example.org.evil.com", list)).toBe(false);
  });

  it("describes presets with their hosts", () => {
    expect(describeAllowlist(["pypi", "x.dev"])).toEqual([
      "pypi: pypi.org, files.pythonhosted.org",
      "x.dev",
    ]);
  });

  it("reads host:port", () => {
    expect(parseAuthority("pypi.org:443")).toEqual({ host: "pypi.org", port: 443 });
    expect(parseAuthority("[::1]:80")).toEqual({ host: "::1", port: 80 });
    expect(parseAuthority("pypi.org")).toBeUndefined();
    expect(parseAuthority("x:70000")).toBeUndefined();
  });

  it("gives a sandboxed command the proxy variables, and nothing otherwise", () => {
    const base: ExecPolicy = {
      root: "/r",
      sandbox: true,
      writePaths: [],
      denyWritePaths: [],
      denyReadPaths: [],
      network: false,
      envAllowlist: [],
      timeoutMs: 1,
      maxOutputBytes: 1,
    };
    const proxy = { port: 4567, socketPath: "/tmp/p.sock" };
    expect(proxyEnv(base)).toEqual({});
    expect(proxyEnv({ ...base, sandbox: false, proxy })).toEqual({});
    const env = proxyEnv({ ...base, proxy });
    expect(env).toMatchObject({
      HTTPS_PROXY: "http://127.0.0.1:4567",
      http_proxy: "http://127.0.0.1:4567",
      NO_PROXY: "localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1",
    });
    expect(env.MAVEN_OPTS).toContain("-Dhttps.proxyPort=4567");

    // A host MAVEN_OPTS outside the allowlist stays out (0.14, review); an allowlisted one stays in.
    const before = process.env.MAVEN_OPTS;
    process.env.MAVEN_OPTS = "-Dhost.only=marker";
    try {
      expect(proxyEnv({ ...base, proxy }).MAVEN_OPTS).not.toContain("marker");
      expect(proxyEnv({ ...base, proxy, envAllowlist: ["MAVEN_OPTS"] }).MAVEN_OPTS).toContain(
        "-Dhost.only=marker",
      );
    } finally {
      if (before === undefined) delete process.env.MAVEN_OPTS;
      else process.env.MAVEN_OPTS = before;
    }
  });

  it("runs the bridge in bubblewrap's network namespace only when there is a bridge", () => {
    const policy: ExecPolicy = {
      root: "/r",
      sandbox: true,
      writePaths: [],
      denyWritePaths: [],
      denyReadPaths: [],
      network: false,
      envAllowlist: [],
      timeoutMs: 1,
      maxOutputBytes: 1,
    };
    const plain = bwrapArgs("make", policy, () => undefined);
    expect(plain.slice(-3)).toEqual(["bash", "-c", "make"]);
    const proxy = { port: 4567, socketPath: "/tmp/p.sock", bridge: "/usr/bin/node" };
    const bridged = bwrapArgs("make", { ...policy, proxy }, () => undefined);
    expect(bridged).toContain("--unshare-net");
    const at = bridged.indexOf("garuda-bridge");
    expect(bridged.slice(at + 1)).toEqual([
      "/usr/bin/node",
      BRIDGE_JS,
      "/tmp/p.sock",
      "4567",
      "bash",
      "-c",
      "make",
    ]);
  });
});

/** An upstream web server on 127.0.0.1 that names the path it got. */
function upstream(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => res.end(`upstream ${req.url}`));
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    );
  });
}

/** A raw CONNECT through the proxy: the status line, then what the tunnel returns. */
function connectThrough(proxyPort: number, authority: string, send = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: authority,
    });
    req.on("connect", (res, socket) => {
      const data = `${res.statusCode}`;
      if (res.statusCode !== 200) {
        socket.destroy();
        resolve(data);
        return;
      }
      socket.once("data", (d) => {
        socket.destroy();
        resolve(`${data} ${String(d)}`);
      });
      socket.write(send);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the proxy (0.13)", () => {
  let proxy: NetworkProxy;
  let port = 0;
  let up: { server: Server; port: number };
  let echo: ReturnType<typeof createServer>;
  let echoPort = 0;
  const asked: string[] = [];

  beforeAll(async () => {
    up = await upstream();
    echo = createServer((c) => c.pipe(c));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    echoPort = (echo.address() as AddressInfo).port;
    proxy = new NetworkProxy({
      decide: async (host, p) => {
        asked.push(`${host}:${p}`);
        return host === "allowed.test" || host === "private.test"
          ? { allowed: true }
          : { allowed: false, reason: "not on the list" };
      },
      resolve: async (host) =>
        host === "private.test"
          ? [{ address: "10.0.0.5", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }],
      addressAllowed: (a) => a === "127.0.0.1",
    });
    ({ port } = await proxy.start());
  });
  afterAll(async () => {
    await proxy.close();
    up.server.close();
    echo.close();
  });

  it("tunnels https to an allowed host, and refuses the others with the reason", async () => {
    const ok = await connectThrough(port, `allowed.test:${echoPort}`, "ping");
    expect(ok).toBe("200 ping");
    expect(await connectThrough(port, "denied.test:443")).toBe("403");
    expect(proxy.takeBlocked()).toEqual([
      {
        host: "denied.test",
        port: 443,
        reason: "Garuda's network allowlist blocked denied.test:443: not on the list.",
      },
    ]);
    expect(proxy.takeBlocked()).toEqual([]);
  });

  it("refuses IP addresses and hosts that resolve to private addresses", async () => {
    expect(await connectThrough(port, "127.0.0.1:443")).toBe("403");
    const before = asked.length;
    expect(await connectThrough(port, "private.test:443")).toBe("403");
    expect(asked.length).toBe(before + 1);
    const reasons = proxy.takeBlocked().map((b) => b.reason);
    expect(reasons[0]).toMatch(/use a host name, not the address 127\.0\.0\.1/);
    expect(reasons[1]).toMatch(/does not resolve to public addresses only/);
  });

  it("forwards plain http to an allowed host, and gives 403 with the reason otherwise", async () => {
    const get = (url: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: url }, (res) => {
          let body = "";
          res.on("data", (d) => {
            body += String(d);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      });
    expect(await get(`http://allowed.test:${up.port}/pkg?x=1`)).toEqual({
      status: 200,
      body: "upstream /pkg?x=1",
    });
    const denied = await get(`http://denied.test:${up.port}/`);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatch(/blocked denied\.test/);
    proxy.takeBlocked();
  });
});

// The real sandbox of this machine: curl reaches an allowed host only through the proxy.
const found = findOsSandbox();
const osExecutor = "executor" in found ? found.executor : undefined;
const hasCurl = ["/usr/bin/curl", "/bin/curl"].some((p) => {
  try {
    return realpathSync(p) !== "";
  } catch {
    return false;
  }
});

describe.runIf(osExecutor !== undefined && hasCurl)("the proxy with the OS sandbox (0.13)", () => {
  const executor = osExecutor as NonNullable<typeof osExecutor>;
  const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-netbox-")));
  const root = join(base, "root");
  mkdirSync(root);
  let proxy: NetworkProxy;
  let proxyPolicy: NonNullable<ExecPolicy["proxy"]>;
  let up: { server: Server; port: number };

  beforeAll(async () => {
    up = await upstream();
    proxy = new NetworkProxy({
      decide: async (host) => ({ allowed: host === "allowed.test" }),
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      addressAllowed: () => true,
    });
    const started = await proxy.start();
    proxyPolicy = { ...started, bridge: process.execPath };
  });
  afterAll(async () => {
    await proxy.close();
    up.server.close();
    rmSync(base, { recursive: true, force: true });
  });

  const policy = (over: Partial<ExecPolicy> = {}): ExecPolicy => ({
    root,
    sandbox: true,
    writePaths: [root],
    denyWritePaths: [],
    denyReadPaths: [],
    network: false,
    envAllowlist: ["PATH", "HOME"],
    timeoutMs: 15_000,
    maxOutputBytes: 10_000,
    proxy: proxyPolicy,
    ...over,
  });

  it("reaches an allowed host through the proxy, and gets 403 for another", async () => {
    const ok = await executor.run(`curl -sS http://allowed.test:${up.port}/hi`, policy());
    expect(ok.stdout.text).toBe("upstream /hi");
    const no = await executor.run(
      `curl -sS -o /dev/null -w "%{http_code}" http://denied.test:${up.port}/`,
      policy(),
    );
    expect(no.stdout.text).toBe("403");
    const tls = await executor.run("curl -sS https://denied.test/ 2>&1; echo", policy());
    expect(tls.stdout.text).toMatch(/403|CONNECT/);
  }, 30_000);

  it("has no network without the proxy", async () => {
    const r = await executor.run(
      `curl -sS --max-time 3 http://allowed.test:${up.port}/hi`,
      (({ proxy: _, ...rest }) => rest)(policy()),
    );
    expect(r.exitCode).not.toBe(0);
  }, 30_000);
});
