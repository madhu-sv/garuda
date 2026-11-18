import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sandboxPaths } from "../src/permissions/sandboxPaths.js";
import { findOsSandbox } from "../src/sandbox/index.js";
import type { ExecPolicy } from "../src/sandbox/types.js";

/**
 * A deputy over a Unix socket (after 0.21.0): a daemon running with the user's rights acts for a
 * sandboxed command over its socket (Docker, ssh-agent, gpg-agent …). The sandbox must block the
 * connection. This test makes its own socket, so it needs no real daemon. It runs in this
 * machine's sandbox: bubblewrap here on Linux, Seatbelt on the user's Mac.
 */

const found = findOsSandbox();
const executor = "executor" in found ? found.executor : undefined;

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-unixsock-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe.runIf(executor !== undefined)("a Unix socket in this machine's sandbox", () => {
  it("a sandboxed command cannot connect to a socket outside the sandbox", async () => {
    const run = executor as NonNullable<typeof executor>;
    const root = join(base, "project");
    const socket = join(base, "deputy.sock");
    mkdirSync(root, { recursive: true });
    let server: Server | undefined;
    await new Promise<void>((resolve, reject) => {
      server = createServer((c) => c.end("secret\n"));
      server.once("error", reject);
      server.listen(socket, resolve);
    });

    const client = join(root, "client.cjs");
    writeFileSync(
      client,
      `const net = require("node:net");
const s = net.connect(${JSON.stringify(socket)});
s.on("connect", () => { process.stdout.write("CONNECTED"); s.destroy(); });
s.on("data", (d) => process.stdout.write(String(d)));
s.on("error", (e) => { process.stdout.write("REFUSED:" + e.code); });
setTimeout(() => process.exit(0), 2000);
`,
    );
    const paths = sandboxPaths(root, {}, join(base, "home"));
    const policy: ExecPolicy = {
      root,
      sandbox: true,
      writePaths: paths.writePaths,
      denyWritePaths: paths.denyWritePaths,
      // The socket lives beside the project; name it so the deny list covers it on both sandboxes.
      denyReadPaths: [...paths.denyReadPaths, socket],
      network: false,
      envAllowlist: ["PATH"],
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    };
    try {
      const result = await run.run(`node ${JSON.stringify(client)}`, policy);
      expect(result.stdout.text).not.toContain("CONNECTED");
      expect(result.stdout.text).not.toContain("secret");
    } finally {
      server?.close();
    }
  });
});
