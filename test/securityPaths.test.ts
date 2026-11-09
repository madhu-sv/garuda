import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeDenials, sandboxPaths } from "../src/permissions/sandboxPaths.js";
import { bwrapArgs } from "../src/sandbox/bwrap.js";
import type { ExecPolicy } from "../src/sandbox/types.js";

/**
 * 0.19.1 (docs/lld/reads.md, decision 4): keys that only publishing needs are unreadable, and on
 * Linux the user's runtime folder (the session bus, through which the keyring answers) is hidden.
 */

const home = "/home/me";

describe("keys that only publishing needs", () => {
  it("are unreadable for sandboxed commands", () => {
    const deny = sandboxPaths("/home/me/p", {}, home, "linux").denyReadPaths;
    for (const file of [
      ".cargo/credentials.toml",
      ".cargo/credentials",
      ".gem/credentials",
      ".m2/settings-security.xml",
    ]) {
      expect(deny).toContain(join(home, file));
    }
    // What builds read stays readable: the caches and the Maven settings.
    expect(deny).not.toContain(join(home, ".cargo"));
    expect(deny).not.toContain(join(home, ".m2"));
    expect(deny).not.toContain(join(home, ".m2/settings.xml"));
  });
});

describe("the Linux runtime folder", () => {
  it("is hidden on Linux, not elsewhere, and not when a write path is inside it", () => {
    expect(runtimeDenials(["/home/me/p", "/tmp"], "linux", 1000)).toEqual(["/run/user/1000"]);
    expect(runtimeDenials(["/home/me/p", "/tmp"], "darwin", 501)).toEqual([]);
    expect(runtimeDenials(["/home/me/p"], "linux", null)).toEqual([]);
    // A TMPDIR in the runtime folder: hiding it would break the command's temp files.
    expect(runtimeDenials(["/home/me/p", "/run/user/1000/tmp"], "linux", 1000)).toEqual([]);
    expect(runtimeDenials(["/run/user/10000"], "linux", 1000)).toEqual(["/run/user/1000"]);
  });

  it("goes into the sandbox's denied reads, and bubblewrap covers it with an empty folder", () => {
    const uid = process.getuid?.();
    const linux = sandboxPaths("/home/me/p", {}, home, "linux").denyReadPaths;
    const mac = sandboxPaths("/Users/me/p", {}, "/Users/me", "darwin").denyReadPaths;
    if (uid !== undefined) expect(linux).toContain(`/run/user/${uid}`);
    expect(mac.some((p) => p.startsWith("/run/user"))).toBe(false);
    const policy: ExecPolicy = {
      root: "/home/me/p",
      sandbox: true,
      writePaths: ["/home/me/p"],
      denyWritePaths: [],
      denyReadPaths: ["/run/user/1000"],
      network: false,
      envAllowlist: [],
      timeoutMs: 1_000,
      maxOutputBytes: 1_000,
    };
    const args = bwrapArgs("secret-tool lookup x y", policy, () => "dir").join(" ");
    expect(args).toContain("--tmpfs /run/user/1000 --remount-ro /run/user/1000");
  });
});
