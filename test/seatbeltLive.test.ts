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
 * - A probe for adb's port (docs/lld/mobile.md): which rule blocks localhost:5037 and keeps the rest
 *   of localhost? In the user's hand test (0.20.1) the forms tried blocked all of localhost or
 *   nothing. The probe prints a table and fails only if Garuda's own profile breaks localhost.
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
const GARUDA_ALLOW = '(allow network-outbound (remote ip "localhost:*"))';
const GARUDA_DENY = '(deny network-outbound (remote ip "*:*"))';
/** Denials only (the form that blocked one port in 0.20.1): no "deny all, allow localhost". */
const denialsOnly = (p: string, port?: string) =>
  p
    .replace(GARUDA_DENY, '(deny network-outbound (require-not (remote ip "localhost:*")))')
    .replace(
      GARUDA_ALLOW,
      port === undefined ? "" : `(deny network-outbound (remote ip "${port}"))`,
    );

/** Candidate rules: a name and how each changes Garuda's profile. */
const CANDIDATES: [string, (profile: string) => string][] = [
  ["Garuda's profile (no port rule)", (p) => p],
  [
    'deny remote ip "localhost:5037", after',
    (p) => `${p}\n(deny network-outbound (remote ip "localhost:5037"))`,
  ],
  ['deny remote ip "*:5037", after', (p) => `${p}\n(deny network-outbound (remote ip "*:5037"))`],
  ['deny remote tcp "*:5037", after', (p) => `${p}\n(deny network-outbound (remote tcp "*:5037"))`],
  [
    'deny remote tcp4 "*:5037", after',
    (p) => `${p}\n(deny network-outbound (remote tcp4 "*:5037"))`,
  ],
  [
    'deny network* remote ip "localhost:5037", after',
    (p) => `${p}\n(deny network* (remote ip "localhost:5037"))`,
  ],
  [
    "allow localhost with require-not 5037",
    (p) =>
      p.replace(
        GARUDA_ALLOW,
        '(allow network-outbound (require-all (remote ip "localhost:*") (require-not (remote ip "localhost:5037"))))',
      ),
  ],
  ["denials only, no port rule (control)", (p) => denialsOnly(p)],
  ['denials only, deny "localhost:5037"', (p) => denialsOnly(p, "localhost:5037")],
  ['denials only, deny "*:5037"', (p) => denialsOnly(p, "*:5037")],
  [
    "allow localhost with require-not *:5037",
    (p) =>
      p.replace(
        GARUDA_ALLOW,
        '(allow network-outbound (require-all (remote ip "localhost:*") (require-not (remote ip "*:5037"))))',
      ),
  ],
];

describe.runIf(darwin)("a probe for adb's port (T14)", () => {
  const servers: Server[] = [];
  const script = join(base, "client.cjs");
  let local = "";
  let lan = "";
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
    // This machine's own network address: not localhost, so the sandbox must block it. No internet
    // is needed.
    const address = Object.values(networkInterfaces())
      .flat()
      .find((a) => a !== undefined && a.family === "IPv4" && !a.internal)?.address;
    if (address !== undefined) lan = `${address}:${await listen(0, address)}`;
    writeFileSync(script, CLIENT);
    const outside = await host.run(`node '${script}' ${local} ${adb} ${lan}`, {
      ...policy,
      sandbox: false,
      envAllowlist: ["PATH"],
    });
    adbReachable = outside.stdout.text.includes(`"${adb}":"ok"`);
    if (lan !== "" && !outside.stdout.text.includes(`"${lan}":"ok"`)) lan = "";
  });
  afterAll(() => {
    for (const s of servers) s.close();
  });

  it("prints which rule blocks 5037 and keeps the other port; Garuda's profile keeps localhost", async () => {
    if (!adbReachable) {
      console.log("skipped: nothing listens on 127.0.0.1:5037, also outside the sandbox");
      return;
    }
    const rows: string[] = [];
    let garuda: Record<string, string> | undefined;
    for (const [name, change] of CANDIDATES) {
      const r = await sandboxed(
        change(seatbeltProfile(policy)),
        `node '${script}' ${local} ${adb} ${lan}`,
      );
      let result: Record<string, string> | undefined;
      try {
        result = JSON.parse(r.stdout.text.trim()) as Record<string, string>;
      } catch {
        result = undefined;
      }
      const cell =
        result === undefined
          ? `profile error (exit ${r.exitCode}): ${r.stderr.text.trim().split("\n")[0] ?? ""}`
          : `other port ${result[local]}, 5037 ${result[adb]}, network ${lan === "" ? "not tested" : result[lan]}`;
      const wanted =
        result?.[local] === "ok" &&
        result?.[adb] !== "ok" &&
        (lan === "" || result?.[lan] !== "ok");
      rows.push(`${wanted ? "WORKS " : "      "}${name}: ${cell}`);
      if (name.startsWith("Garuda")) garuda = result;
    }
    console.log(`Seatbelt port probe (T14, adb):\n${rows.join("\n")}`);
    // Garuda's own profile must keep localhost (local test servers and Garuda's proxy need it), and
    // must block the machine's own network address.
    expect(garuda?.[local]).toBe("ok");
    if (lan !== "") expect(garuda?.[lan]).toBe("blocked");
  }, 120_000);
});
