import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HostExecutor } from "../src/sandbox/host.js";
import { seatbeltProfile } from "../src/sandbox/seatbelt.js";
import type { ExecPolicy } from "../src/sandbox/types.js";

/**
 * Seatbelt rules run for real, on macOS only (CI's macos-latest job and the user's Mac). The other
 * Seatbelt tests check the profile's text; these start `sandbox-exec` with it.
 *
 * - The simulator rule (0.20.1): a sandboxed `xcrun simctl` must fail where an outside one works.
 * - adb's port (T14, docs/lld/mobile.md): Garuda's profile blocks localhost:5037 and keeps the rest
 *   of localhost, with the network off and on. Before, the profile allowed localhost and then could
 *   not take one port back out: every form tried blocked all of localhost or nothing. A probe of
 *   eleven rule forms on the user's Mac found that only rules that deny work. An outside host is
 *   tried only with GARUDA_PROBE_INTERNET=1 (the suite never needs the internet).
 */

const darwin = process.platform === "darwin";
const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-seatbelt-live-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const policy: ExecPolicy = {
  root: base,
  sandbox: true,
  writePaths: [base],
  denyWritePaths: [],
  denyReadPaths: [],
  network: false,
  envAllowlist: [],
  timeoutMs: 60_000,
  maxOutputBytes: 20_000,
};

const host = new HostExecutor();
let n = 0;
/** Run `command` under `profile` with sandbox-exec, on the host (the probe sets its own rules). */
async function sandboxed(profile: string, command: string) {
  const file = join(base, `p${n++}.sb`);
  writeFileSync(file, profile);
  return host.run(`sandbox-exec -f '${file}' ${command}`, {
    ...policy,
    sandbox: false,
    envAllowlist: ["PATH", "HOME", "DEVELOPER_DIR"],
  });
}

describe.runIf(darwin)("the simulator rule, for real (0.20.1)", () => {
  it("a sandboxed xcrun simctl cannot reach CoreSimulator", async () => {
    const outside = await host.run("xcrun simctl list devices", {
      ...policy,
      sandbox: false,
      envAllowlist: ["PATH", "HOME", "DEVELOPER_DIR"],
    });
    if (outside.exitCode !== 0) {
      console.log("skipped: xcrun simctl does not work here, also outside the sandbox");
      return;
    }
    const inside = await sandboxed(seatbeltProfile(policy), "xcrun simctl list devices");
    expect(inside.exitCode, inside.stdout.text).not.toBe(0);
  }, 120_000);
});

// The client: connects to each host:port and prints {"host:port": "ok" | "blocked" | "timeout"}.
const CLIENT = `
const net = require("node:net");
const targets = process.argv.slice(2);
const out = {};
let left = targets.length;
for (const target of targets) {
  const [host, port] = target.split(":");
  const s = net.connect({ host, port: Number(port) });
  const done = (r) => { if (out[target] === undefined) { out[target] = r; s.destroy(); if (--left === 0) console.log(JSON.stringify(out)); } };
  s.on("connect", () => done("ok"));
  s.on("error", () => done("blocked"));
  setTimeout(() => done("timeout"), 3000);
}
`;

const ADB = 5037;

describe.runIf(darwin)("adb's port, for real (T14)", () => {
  const servers: Server[] = [];
  const script = join(base, "client.cjs");
  let local = "";
  let own = "";
  let remote = "";
  const adb = `127.0.0.1:${ADB}`;
  let adbReachable = false;

  beforeAll(async () => {
    const listen = (port: number, host = "127.0.0.1") =>
      new Promise<number>((resolve, reject) => {
        const server = createServer((socket) => socket.end());
        server.once("error", reject);
        server.listen(port, host, () => {
          servers.push(server);
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? address.port : port);
        });
      });
    local = `127.0.0.1:${await listen(0)}`;
    // A real adb server may hold 5037 already: then it is the one to block.
    await listen(ADB).catch(() => undefined);
    // This machine's own network address. Seatbelt's "localhost" covers it (the user's Mac,
    // 2026-11-18): it is the same machine, like 127.0.0.1. Printed, not judged.
    const address = Object.values(networkInterfaces())
      .flat()
      .find((a) => a !== undefined && a.family === "IPv4" && !a.internal)?.address;
    if (address !== undefined) own = `${address}:${await listen(0, address)}`;
    // An outside host, only on request: the suite never needs the internet.
    if (process.env.GARUDA_PROBE_INTERNET === "1") remote = "1.1.1.1:443";
    writeFileSync(script, CLIENT);
    const outside = await host.run(`node '${script}' ${local} ${adb} ${own} ${remote}`, {
      ...policy,
      sandbox: false,
      envAllowlist: ["PATH"],
    });
    adbReachable = outside.stdout.text.includes(`"${adb}":"ok"`);
    if (own !== "" && !outside.stdout.text.includes(`"${own}":"ok"`)) own = "";
    if (remote !== "" && !outside.stdout.text.includes(`"${remote}":"ok"`)) remote = "";
  });
  afterAll(() => {
    for (const s of servers) s.close();
  });

  it("Garuda's profile blocks 5037 and keeps localhost; the network stays blocked", async () => {
    if (!adbReachable) {
      console.log("skipped: nothing listens on 127.0.0.1:5037, also outside the sandbox");
      return;
    }
    if (remote === "") console.log("Outside host not tested: set GARUDA_PROBE_INTERNET=1.");
    for (const network of [false, true]) {
      const r = await sandboxed(
        seatbeltProfile({ ...policy, network }),
        `node '${script}' ${local} ${adb} ${own} ${remote}`,
      );
      const result = JSON.parse(r.stdout.text.trim()) as Record<string, string>;
      console.log(`network ${network ? "on" : "off"}: ${JSON.stringify(result)}`);
      // Local test servers and Garuda's proxy need localhost; the adb server must stay out of reach.
      expect(result[local], `network ${network}`).toBe("ok");
      expect(result[adb], `network ${network}`).not.toBe("ok");
      // This machine's own address is localhost to Seatbelt: the same machine.
      if (own !== "") expect(result[own]).toBe("ok");
      if (remote !== "") expect(result[remote]).toBe(network ? "ok" : "blocked");
    }
  }, 120_000);
});
