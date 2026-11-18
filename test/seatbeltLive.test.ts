import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
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

// The client: connects to each port on 127.0.0.1 and prints {port: "ok" | "blocked"}.
const CLIENT = `
const net = require("node:net");
const ports = process.argv.slice(2).map(Number);
const out = {};
let left = ports.length;
for (const port of ports) {
  const s = net.connect({ host: "127.0.0.1", port });
  const done = (r) => { if (out[port] === undefined) { out[port] = r; s.destroy(); if (--left === 0) console.log(JSON.stringify(out)); } };
  s.on("connect", () => done("ok"));
  s.on("error", () => done("blocked"));
  setTimeout(() => done("timeout"), 3000);
}
`;

const ADB = 5037;
const GARUDA_ALLOW = '(allow network-outbound (remote ip "localhost:*"))';

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
  let other = 0;
  let adbReachable = false;

  beforeAll(async () => {
    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        const server = createServer((socket) => socket.end());
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          servers.push(server);
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? address.port : port);
        });
      });
    other = await listen(0);
    // A real adb server may hold 5037 already: then it is the one to block.
    await listen(ADB).catch(() => undefined);
    writeFileSync(script, CLIENT);
    const outside = await host.run(`node '${script}' ${other} ${ADB}`, {
      ...policy,
      sandbox: false,
      envAllowlist: ["PATH"],
    });
    adbReachable = outside.stdout.text.includes(`"${ADB}":"ok"`);
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
    let garuda = "";
    for (const [name, change] of CANDIDATES) {
      const r = await sandboxed(
        change(seatbeltProfile(policy)),
        `node '${script}' ${other} ${ADB}`,
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
          : `other port ${result[other]}, 5037 ${result[ADB]}`;
      const wanted = result?.[other] === "ok" && result?.[ADB] !== "ok";
      rows.push(`${wanted ? "WORKS " : "      "}${name}: ${cell}`);
      if (name.startsWith("Garuda")) garuda = result?.[other] ?? "error";
    }
    console.log(`Seatbelt port probe (T14, adb):\n${rows.join("\n")}`);
    // Garuda's own profile must keep localhost: local test servers and Garuda's proxy need it.
    expect(garuda).toBe("ok");
  }, 120_000);
});
