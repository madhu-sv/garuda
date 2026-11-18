import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { realPath, sandboxPaths } from "../src/permissions/sandboxPaths.js";
import { findOsSandbox } from "../src/sandbox/index.js";

/**
 * T14, the user's iOS check: Seatbelt compares real paths, and on macOS /var is a link to
 * /private/var. A `sandbox.writePaths` entry under /var/folders never matched, and a `denyRead`
 * entry through a link would have left the file readable.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-real-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const real = join(base, "real");
const link = join(base, "link");
mkdirSync(join(real, "sub"), { recursive: true });
writeFileSync(join(real, "secret.txt"), "s\n");
symlinkSync(real, link, "dir");

describe("realPath", () => {
  it("resolves the nearest folder that exists and adds the rest back", () => {
    expect(realPath(join(link, "sub"))).toBe(join(real, "sub"));
    // A cache folder that a build makes later.
    expect(realPath(join(link, "sub", "clang", "ModuleCache"))).toBe(
      join(real, "sub", "clang", "ModuleCache"),
    );
    expect(realPath(join(real, "sub"))).toBe(join(real, "sub"));
  });
});

describe("the settings' paths", () => {
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });

  it("a write path through a link becomes the real path", () => {
    const paths = sandboxPaths(root, { writePaths: [join(link, "sub", "cache")] }, join(base, "h"));
    expect(paths.writePaths).toContain(join(real, "sub", "cache"));
    expect(paths.writePaths).not.toContain(join(link, "sub", "cache"));
  });

  it("a denied path through a link is denied under both spellings", () => {
    const paths = sandboxPaths(root, { denyRead: [join(link, "secret.txt")] }, join(base, "h"));
    expect(paths.denyReadPaths).toContain(join(link, "secret.txt"));
    expect(paths.denyReadPaths).toContain(join(real, "secret.txt"));
  });
});

// In this machine's sandbox: the denial named through the link holds.
const found = findOsSandbox();
const executor = "executor" in found ? found.executor : undefined;

describe.runIf(executor !== undefined)("in this machine's sandbox", () => {
  it("a file denied through a link stays unreadable", async () => {
    const root = join(base, "project2");
    mkdirSync(root, { recursive: true });
    const paths = sandboxPaths(root, { denyRead: [join(link, "secret.txt")] }, join(base, "h"));
    const result = await (executor as NonNullable<typeof executor>).run(
      `cat "${join(real, "secret.txt")}"`,
      {
        root,
        sandbox: true,
        writePaths: paths.writePaths,
        denyWritePaths: paths.denyWritePaths,
        denyReadPaths: paths.denyReadPaths,
        network: false,
        envAllowlist: [],
        timeoutMs: 10_000,
        maxOutputBytes: 10_000,
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.text).not.toContain("s");
  });
});
