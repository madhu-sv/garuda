import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  checkServerUrl,
  defHash,
  type HttpDef,
  loadMcpConfig,
  type ServerConfig,
} from "../src/mcp/config.js";
import { connectHttp } from "../src/mcp/http.js";
import { McpManager } from "../src/mcp/manager.js";
import { AuthStore, authKey, waitForCallback } from "../src/mcp/oauth.js";
import { TrustStore } from "../src/mcp/trust.js";
import { BlockedAddressError, pinnedFetch } from "../src/net/pinnedFetch.js";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../src/permissions/types.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { startHttpFixture } from "./fixtures/mcpHttpServer.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-mcp-http-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let count = 0;
function folder(name: string): string {
  const dir = join(base, `${name}-${++count}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const signal = () => new AbortController().signal;

class Recorder implements Approver {
  readonly requests: ApprovalRequest[] = [];
  constructor(private readonly answers: ApprovalChoice[] = []) {}
  async ask(request: ApprovalRequest): Promise<ApprovalChoice> {
    this.requests.push(request);
    return this.answers.shift() ?? "deny";
  }
}

/** A "browser" that follows the sign-in page's redirect to Garuda's callback. */
const browser = async (url: URL) => {
  const page = await fetch(url, { redirect: "manual" });
  const location = page.headers.get("location");
  if (location !== null) await fetch(location);
};

const remote = (name: string, url: string, source: "user" | "project" = "user") =>
  ({
    name,
    source,
    file: `${source}/mcp.json`,
    def: { url, timeoutMs: 10_000, enabled: true },
  }) as ServerConfig & { def: HttpDef };

async function managerFor(options: {
  approver: Approver;
  home: string;
  root?: string;
  auth?: AuthStore;
  openBrowser?: (url: URL) => Promise<void>;
  notices?: string[];
}) {
  const root = options.root ?? folder("root");
  return new McpManager({
    root,
    executor: new HostExecutor(),
    approver: options.approver,
    trust: await TrustStore.open(options.home),
    auth: options.auth ?? (await AuthStore.open(options.home)),
    openBrowser: options.openBrowser ?? browser,
    notify: (t) => options.notices?.push(t),
  });
}

describe("remote MCP server URLs (0.4)", () => {
  it("https only; http only for localhost in the user's own file; public addresses for projects", () => {
    expect(checkServerUrl("https://mcp.example.com/mcp", "project")).toBeUndefined();
    expect(checkServerUrl("http://127.0.0.1:8080/mcp", "user")).toBeUndefined();
    expect(checkServerUrl("http://localhost/mcp", "user")).toBeUndefined();
    expect(checkServerUrl("http://mcp.example.com/mcp", "user")).toMatch(/use https/);
    expect(checkServerUrl("http://127.0.0.1/mcp", "project")).toMatch(/use https/);
    expect(checkServerUrl("https://localhost/mcp", "project")).toMatch(/public address/);
    expect(checkServerUrl("https://10.1.2.3/mcp", "project")).toMatch(/public address/);
    expect(checkServerUrl("https://[::1]/mcp", "project")).toMatch(/public address/);
    expect(checkServerUrl("https://u:p@mcp.example.com/", "user")).toMatch(/user name or password/);
    expect(checkServerUrl("https://mcp.example.com/#x", "user")).toMatch(/fragment/);
    expect(checkServerUrl("ftp://mcp.example.com/", "user")).toMatch(/only https/);
    expect(checkServerUrl("not a url", "user")).toMatch(/not a valid URL/);
  });

  it("reads url servers from mcp.json, reports bad ones, and pins consent to the URL", async () => {
    const home = folder("home");
    const root = folder("root");
    mkdirSync(join(home, ".garuda"));
    mkdirSync(join(root, ".garuda"));
    writeFileSync(
      join(home, ".garuda", "mcp.json"),
      JSON.stringify({ servers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } }),
    );
    writeFileSync(
      join(root, ".garuda", "mcp.json"),
      JSON.stringify({ servers: { local: { url: "http://127.0.0.1:9/mcp" } } }),
    );
    const { servers, problems } = await loadMcpConfig({ home, root });
    expect(servers.map((s) => s.name)).toEqual(["linear"]);
    expect(problems.join("\n")).toMatch(/server "local": use https/);
    const a: HttpDef = { url: "https://a.example/mcp", timeoutMs: 1_000, enabled: true };
    expect(defHash(a)).toBe(defHash({ ...a, timeoutMs: 9_000, enabled: false }));
    expect(defHash(a)).not.toBe(defHash({ ...a, url: "https://b.example/mcp" }));
  });
});

describe("pinned fetch for project servers (0.4)", () => {
  it("refuses private and loopback addresses before it connects", async () => {
    const privateDns = pinnedFetch({ resolve: async () => [{ address: "10.0.0.7", family: 4 }] });
    await expect(privateDns("https://mcp.example.com/mcp")).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
    const mixed = pinnedFetch({
      resolve: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });
    await expect(mixed("https://mcp.example.com/mcp")).rejects.toThrow(/loopback address/);
    await expect(pinnedFetch()("http://127.0.0.1:1/mcp")).rejects.toThrow(/loopback/);
  });
});

describe("remote MCP servers over Streamable HTTP (0.4)", () => {
  it("connects, lists and calls tools; /mcp shows it as remote", async () => {
    const fixture = await startHttpFixture({ oauth: false });
    const manager = await managerFor({ approver: new Recorder(), home: folder("home") });
    const tools = await manager.start([remote("plain", fixture.url)], signal());
    expect(tools.map((t) => t.name)).toEqual(["mcp__plain__echo"]);
    const result = await manager.call("plain", "echo", { text: "hi" }, signal());
    expect(result.content).toEqual([{ type: "text", text: "remote echo: hi" }]);
    expect(manager.status()[0]).toMatchObject({
      transport: "http",
      state: "connected",
      sandboxed: false,
      network: true,
      url: fixture.url,
      signedIn: false,
    });
    await manager.close();
    await fixture.close();
  });

  it("a project server's sign-in page on http://127.0.0.1 is not opened (0.14.1, review)", async () => {
    // Opening it would send the browser, with its cookies, to a service on this machine.
    const fixture = await startHttpFixture({ oauth: true });
    const approver = new Recorder(["once"]);
    let opened = false;
    await expect(
      connectHttp(
        remote("proj", fixture.url, "project"),
        {
          scope: "proj-root",
          auth: await AuthStore.open(folder("home")),
          approver,
          executor: new HostExecutor(),
          notify: () => {},
          openBrowser: async () => {
            opened = true;
          },
          connectTimeoutMs: 10_000,
        },
        signal(),
      ),
    ).rejects.toThrow(/sign-in page is not https/);
    expect(approver.requests).toEqual([]);
    expect(opened).toBe(false);
  });

  it("OAuth: asks, signs in through the browser with PKCE, keeps the tokens private, and reuses them", async () => {
    const fixture = await startHttpFixture({ oauth: true });
    const home = folder("home");
    const approver = new Recorder(["once"]);
    const notices: string[] = [];
    const manager = await managerFor({ approver, home, notices });
    const warn = vi.spyOn(console, "warn");
    const tools = await manager.start([remote("secure", fixture.url)], signal());
    // The SDK warns when a provider cannot keep the discovery state (SEP-2352); Garuda keeps it.
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/SEP-2352|discoveryState/);
    warn.mockRestore();
    expect(tools.map((t) => t.name)).toEqual(["mcp__secure__echo"]);
    expect(approver.requests[0]).toMatchObject({
      title: 'Sign in to "secure"?',
      question: "Sign in now?",
      choices: ["once", "deny"],
    });
    expect(approver.requests[0]?.preview).toContain(
      `Garuda opens your browser at ${fixture.origin}.`,
    );
    expect(notices.join("\n")).toMatch(/Sign in to MCP server "secure" in your browser/);
    expect(fixture.log).toEqual(expect.arrayContaining(["401", "authorize", "token"]));
    expect(fixture.log.find((l) => l.startsWith("register"))).toMatch(/127\.0\.0\.1:\d+\/callback/);
    expect(manager.status()[0]).toMatchObject({ signedIn: true, state: "connected" });
    const file = join(home, ".garuda", "mcp-auth.json");
    const saved = (await AuthStore.open(home)).get(authKey("~", "secure", fixture.url));
    expect(saved.discovery).toMatchObject({
      authorizationServerUrl: expect.stringContaining("127.0.0.1"),
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await manager.close();
    // A planned stop is not a failure: no "stopped" notice (0.5).
    expect(notices.join("\n")).not.toMatch(/stopped/);
    expect(manager.status()[0]?.state).toBe("stopped");

    // A new session: the saved token works, no question, no browser.
    const again = new Recorder();
    const second = await managerFor({
      approver: again,
      home,
      openBrowser: async () => {
        throw new Error("no browser expected");
      },
    });
    expect((await second.start([remote("secure", fixture.url)], signal())).length).toBe(1);
    expect(again.requests).toEqual([]);

    // /mcp logout: the tokens go; the next session asks again.
    expect(await second.logout("secure")).toBe(1);
    await second.close();
    const store = await AuthStore.open(home);
    expect(store.hasTokens(authKey("~", "secure", fixture.url))).toBe(false);
    const third = new Recorder(["deny"]);
    const notices3: string[] = [];
    const m3 = await managerFor({ approver: third, home, notices: notices3 });
    expect(await m3.start([remote("secure", fixture.url)], signal())).toEqual([]);
    expect(third.requests).toHaveLength(1);
    expect(m3.status()[0]).toMatchObject({
      state: "failed",
      message: "it needs a sign-in, and you skipped it",
    });
    await fixture.close();
  });

  it("an expired token is refreshed with no question and no browser", async () => {
    const fixture = await startHttpFixture({ oauth: true });
    const home = folder("home");
    const first = await managerFor({ approver: new Recorder(["once"]), home });
    await first.start([remote("secure", fixture.url)], signal());
    await first.close();
    fixture.expireTokens();
    const approver = new Recorder();
    const second = await managerFor({
      approver,
      home,
      openBrowser: async () => {
        throw new Error("no browser expected");
      },
    });
    expect((await second.start([remote("secure", fixture.url)], signal())).length).toBe(1);
    expect(approver.requests).toEqual([]);
    expect(fixture.log).toContain("refresh");
    await second.close();
    await fixture.close();
  });

  it("a denied sign-in at the server fails with the short error code only", async () => {
    const fixture = await startHttpFixture({ oauth: true });
    fixture.authorizeMode = "error";
    const notices: string[] = [];
    const manager = await managerFor({
      approver: new Recorder(["once"]),
      home: folder("home"),
      notices,
    });
    expect(await manager.start([remote("secure", fixture.url)], signal())).toEqual([]);
    expect(manager.status()[0]).toMatchObject({
      state: "failed",
      message: "The sign-in failed (access_denied).",
    });
    await fixture.close();
  });

  it("a project server asks for consent first; 'No' means no connection at all", async () => {
    const approver = new Recorder(["deny"]);
    const manager = await managerFor({ approver, home: folder("home") });
    const tools = await manager.start(
      [remote("remote", "https://mcp.example.invalid/mcp", "project")],
      signal(),
    );
    expect(tools).toEqual([]);
    expect(approver.requests[0]?.title).toBe('Connect to MCP server "remote"?');
    expect(approver.requests[0]?.preview).toContain("URL: https://mcp.example.invalid/mcp");
    expect(approver.requests[0]?.preview).toContain("only to public addresses");
    expect(manager.status()[0]).toMatchObject({ state: "denied", transport: "http" });
  });
});

describe("the OAuth callback (0.4)", () => {
  it("ignores a request with another state, and takes the one with ours", async () => {
    const { freePort } = await import("../src/mcp/oauth.js");
    const port = await freePort();
    const callback = waitForCallback(port, () => "ours", signal());
    await callback.listening;
    const wrong = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=theirs`);
    expect(wrong.status).toBe(400);
    const right = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=ours`);
    expect(right.status).toBe(200);
    expect((await callback.result).get("code")).toBe("abc");
  });

  it("Ctrl-C stops the wait", async () => {
    const { freePort } = await import("../src/mcp/oauth.js");
    const controller = new AbortController();
    const callback = waitForCallback(await freePort(), () => "s", controller.signal);
    await callback.listening;
    controller.abort(new Error("stopped by the user"));
    await expect(callback.result).rejects.toThrow("stopped by the user");
  });
});

describe("/mcp logout (0.4)", () => {
  it("says when there are no tokens, and shows the usage for other words", async () => {
    const { Runtime } = await import("../src/app/runtime.js");
    const { runCommand } = await import("../src/cli/chat/commands.js");
    const { ChatStore } = await import("../src/cli/chat/store.js");
    const { noColor } = await import("../src/cli/chat/markdown.js");
    const { FakeModelClient } = await import("../src/model/fake.js");
    const { FileSessionStore } = await import("../src/session/store.js");
    const { parseSettings } = await import("../src/permissions/settings.js");
    const root = folder("root");
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: new FakeModelClient([]),
      approver: new Recorder(),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: { home: folder("home") },
      hooks: false,
      commands: false,
      profiles: [],
    });
    const store = new ChatStore({ model: "fake", sandbox: "none" }, { paint: noColor });
    const context = { runtime, renderer: store, sessionPath: (id: string) => id };
    await runCommand("/mcp logout linear", context);
    await runCommand("/mcp login linear", context);
    expect(store.getState().items.map((i) => i.text)).toEqual([
      'There are no tokens for MCP server "linear".',
      "Use: /mcp, or /mcp logout <server>.",
    ]);
  });
});
