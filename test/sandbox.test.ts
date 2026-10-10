import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { sandboxPaths } from "../src/permissions/sandboxPaths.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { PermissionRequest } from "../src/permissions/types.js";
import { bwrapArgs } from "../src/sandbox/bwrap.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { createExecutor, findOsSandbox } from "../src/sandbox/index.js";
import { seatbeltProfile } from "../src/sandbox/seatbelt.js";
import type { ExecPolicy } from "../src/sandbox/types.js";
import { executorContract } from "./executorContract.js";

const policy = (over: Partial<ExecPolicy> = {}): ExecPolicy => ({
  root: "/repo",
  sandbox: true,
  writePaths: ["/repo", "/tmp"],
  denyWritePaths: ["/repo/.git/hooks"],
  denyReadPaths: ["/home/u/.ssh", "/home/u/.netrc"],
  network: false,
  envAllowlist: ["PATH"],
  timeoutMs: 1_000,
  maxOutputBytes: 1_000,
  ...over,
});

describe("sandbox paths", () => {
  it("allows writes in the root, temp and caches, and protects hooks and settings", () => {
    const p = sandboxPaths("/repo", {}, "/home/u");
    expect(p.writePaths[0]).toBe("/repo");
    expect(p.writePaths).toContain("/home/u/.cache");
    expect(p.denyWritePaths).toEqual(["/repo/.git/hooks", "/repo/.git/config", "/repo/.garuda"]);
    expect(p.denyReadPaths).toContain("/home/u/.ssh");
    expect(p.denyReadPaths).toContain("/home/u/.aws");
    // Tokens of Garuda and Claude Code (0.5); skills in ~/.garuda and ~/.claude stay readable.
    expect(p.denyReadPaths).toEqual(
      expect.arrayContaining([
        "/home/u/.garuda/mcp-auth.json",
        "/home/u/.claude.json",
        "/home/u/.claude/.credentials.json",
      ]),
    );
    expect(p.denyReadPaths).not.toContain("/home/u/.garuda");
    expect(p.denyReadPaths).not.toContain("/home/u/.claude");
  });

  it("adds paths from settings: ~/ is the home folder, relative paths start at the root", () => {
    const p = sandboxPaths(
      "/repo",
      { writePaths: ["~/.gradle", "build"], denyRead: ["~/x"] },
      "/home/u",
    );
    expect(p.writePaths).toContain("/home/u/.gradle");
    expect(p.writePaths).toContain("/repo/build");
    expect(p.denyReadPaths).toContain("/home/u/x");
  });

  it("reads the sandbox block in settings", () => {
    const s = parseSettings({ executor: "os", sandbox: { writePaths: ["~/.m2"] } });
    expect(s).toMatchObject({ executor: "os", sandbox: { writePaths: ["~/.m2"] } });
    expect(parseSettings({}).executor).toBe("auto");
    expect(() => parseSettings({ executor: "docker" })).toThrow();
  });
});

describe("Seatbelt profile", () => {
  it("denies writes, then allows the write paths, then denies protected paths", () => {
    const profile = seatbeltProfile(policy());
    const at = (text: string) => profile.indexOf(text);
    expect(at("(deny file-write*)")).toBeGreaterThan(-1);
    expect(at('(allow file-write* (subpath "/repo") (subpath "/tmp")')).toBeGreaterThan(
      at("(deny file-write*)"),
    );
    // The last matching rule wins, so the protected paths come after the allow.
    expect(at('(deny file-write* (subpath "/repo/.git/hooks"))')).toBeGreaterThan(
      at("(allow file-write*"),
    );
    expect(profile).toContain(
      '(deny file-read* (subpath "/home/u/.ssh") (subpath "/home/u/.netrc"))',
    );
    expect(profile).toContain('(deny network-outbound (remote ip "*:*"))');
  });

  it("does not let a command start apps outside the sandbox (0.14, review)", () => {
    for (const network of [false, true]) {
      const profile = seatbeltProfile(policy({ network }));
      expect(profile).toContain("(deny lsopen)");
      expect(profile).toContain("(deny appleevent-send)");
    }
  });

  it("keeps the network when the policy allows it, and quotes paths", () => {
    const profile = seatbeltProfile(policy({ network: true, writePaths: ['/a "b"\\c'] }));
    expect(profile).not.toContain("network-outbound");
    expect(profile).toContain('(subpath "/a \\"b\\"\\\\c")');
  });
});

describe("bubblewrap arguments", () => {
  const kinds: Record<string, "dir" | "file"> = {
    "/repo": "dir",
    "/tmp": "dir",
    "/repo/.git/hooks": "dir",
    "/home/u/.ssh": "dir",
    "/home/u/.netrc": "file",
  };
  const kind = (p: string) => kinds[p];

  it("mounts / read-only, the write paths writable, and hides denied paths", () => {
    const args = bwrapArgs("make test", policy(), kind).join(" ");
    expect(args).toMatch(/^--ro-bind \/ \/ --dev \/dev --bind \/repo \/repo --bind \/tmp \/tmp/);
    expect(args).toContain("--ro-bind /repo/.git/hooks /repo/.git/hooks");
    expect(args).toContain("--tmpfs /home/u/.ssh --remount-ro /home/u/.ssh");
    expect(args).toContain("--ro-bind /dev/null /home/u/.netrc");
    expect(args).toContain("--unshare-net");
    expect(args).toContain("--unshare-pid --proc /proc");
    expect(args.endsWith("--die-with-parent --chdir /repo -- bash -c make test")).toBe(true);
  });

  it("skips paths that do not exist, and keeps the network when allowed", () => {
    const args = bwrapArgs("x", policy({ network: true }), () => undefined).join(" ");
    expect(args).not.toContain("--bind /repo");
    expect(args).not.toContain("--unshare-net");
    expect(args).toContain("--unshare-pid --proc /proc");
  });
});

describe("createExecutor", () => {
  const none = () => ({ problem: "bwrap is not installed.", fix: "Install it." });

  it('"auto" falls back to the host with a notice when there is no sandbox', () => {
    const { executor, notice } = createExecutor("auto", none);
    expect(executor).toBeInstanceOf(HostExecutor);
    expect(notice).toMatch(/^No OS sandbox: bwrap is not installed\. .*approval\. Install it\.$/);
  });

  it('"os" fails when there is no sandbox', () => {
    expect(() => createExecutor("os", none)).toThrow(/No OS sandbox/);
  });

  it("uses the sandbox when there is one", () => {
    const sandbox = new HostExecutor();
    expect(createExecutor("auto", () => ({ executor: sandbox })).executor).toBe(sandbox);
  });
});

describe("permissions with an OS sandbox", () => {
  const engine = (deny: string[] = []) => {
    const approver = new AutoApprover("once");
    const permissions = new PermissionEngine({
      root: "/repo",
      approver,
      isolation: "os",
      settings: parseSettings({ permissions: { deny } }),
    });
    return { approver, permissions };
  };
  const bash = (command: string, outsideSandbox = false): PermissionRequest => ({
    tool: "bash",
    readOnly: false,
    info: {
      target: { kind: "command", command, ...(outsideSandbox ? { outsideSandbox: true } : {}) },
    },
  });
  const signal = new AbortController().signal;

  it("runs commands in the sandbox with no approval", async () => {
    const { approver, permissions } = engine();
    expect(await permissions.check(bash("pnpm test"), signal)).toEqual({
      allowed: true,
      by: "sandbox",
    });
    expect(approver.requests).toEqual([]);
  });

  it("asks before a command runs outside the sandbox", async () => {
    const { approver, permissions } = engine();
    const d = await permissions.check(bash("pnpm install", true), signal);
    expect(d).toEqual({ allowed: true, by: "user" });
    expect(approver.requests).toMatchObject([{ tool: "bash", isolation: "os" }]);
  });

  it("still applies deny rules in the sandbox", async () => {
    const { permissions } = engine(["bash(rm -rf*)"]);
    expect(await permissions.check(bash("rm -rf build"), signal)).toMatchObject({ allowed: false });
  });
});

// The real sandbox of this machine: Seatbelt on macOS, bubblewrap on Linux.
const found = findOsSandbox();
const osExecutor = "executor" in found ? found.executor : undefined;

describe.runIf(osExecutor !== undefined)("OS sandbox on this machine", () => {
  const executor = osExecutor as NonNullable<typeof osExecutor>;
  const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-sandbox-")));
  const root = join(base, "root");
  const outside = join(base, "outside");
  const secret = join(base, "secret.txt");
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(secret, "top secret\n");
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const sandboxed = (over: Partial<ExecPolicy> = {}): ExecPolicy => ({
    root,
    sandbox: true,
    writePaths: [root],
    denyWritePaths: [join(root, ".git", "hooks")],
    denyReadPaths: [secret],
    network: false,
    envAllowlist: ["PATH", "HOME"],
    timeoutMs: 10_000,
    maxOutputBytes: 10_000,
    ...over,
  });

  it("each runtime gets its own executor: one shutdown does not kill another's command (0.14.1)", async () => {
    // Eval tasks run in parallel, each with its own Runtime. A task that ends calls shutdown();
    // with one shared executor, that killed the other tasks' checks (SIGKILL, no output).
    const mine = createExecutor("os").executor;
    const other = createExecutor("os").executor;
    expect(mine).not.toBe(other);
    const run = mine.run("sleep 0.5 && echo done", sandboxed());
    await new Promise((r) => setTimeout(r, 150));
    other.shutdown();
    const r = await run;
    expect(r).toMatchObject({ exitCode: 0, signal: null });
    expect(r.stdout.text).toContain("done");
  });

  it("writes in the root, but not outside it", async () => {
    const r = await executor.run(`echo a > in.txt && echo b > "${outside}/out.txt"`, sandboxed());
    expect(readFileSync(join(root, "in.txt"), "utf8")).toBe("a\n");
    expect(r.exitCode).not.toBe(0);
    expect(() => readFileSync(join(outside, "out.txt"))).toThrow();
  });

  it("keeps protected paths in the root read-only", async () => {
    const r = await executor.run("echo evil > .git/hooks/pre-commit", sandboxed());
    expect(r.exitCode).not.toBe(0);
    expect(() => readFileSync(join(root, ".git", "hooks", "pre-commit"))).toThrow();
  });

  it("cannot read denied paths", async () => {
    const r = await executor.run(`cat "${secret}"`, sandboxed());
    expect(r.stdout.text).not.toContain("top secret");
  });

  it("a denied file hides only that file: the rest of its folder stays readable (0.5)", async () => {
    // Like ~/.garuda: mcp-auth.json is hidden, skills/ is not.
    const folder = join(base, "dot-garuda");
    mkdirSync(join(folder, "skills"), { recursive: true });
    writeFileSync(join(folder, "mcp-auth.json"), "token-123\n");
    writeFileSync(join(folder, "skills", "SKILL.md"), "skill text\n");
    const policy = sandboxed({ denyReadPaths: [join(folder, "mcp-auth.json")] });
    const hidden = await executor.run(`cat "${folder}/mcp-auth.json"`, policy);
    expect(hidden.stdout.text).not.toContain("token-123");
    const open = await executor.run(`cat "${folder}/skills/SKILL.md"`, policy);
    expect(open.stdout.text).toContain("skill text");
  });

  it("a command cannot read ~/.garuda/credentials; ~/.garuda/skills stays readable (0.16)", async () => {
    // The real default list, for a home folder of this test (never the user's).
    const home = join(base, "home");
    mkdirSync(join(home, ".garuda", "skills"), { recursive: true });
    writeFileSync(join(home, ".garuda", "credentials"), '{"ANTHROPIC_API_KEY":"sk-ant-hidden-1"}');
    writeFileSync(join(home, ".garuda", "skills", "SKILL.md"), "skill text\n");
    const policy = sandboxed({ denyReadPaths: sandboxPaths(root, {}, home).denyReadPaths });
    const hidden = await executor.run(`cat "${home}/.garuda/credentials"`, policy);
    expect(hidden.stdout.text).not.toContain("sk-ant-hidden-1");
    const open = await executor.run(`cat "${home}/.garuda/skills/SKILL.md"`, policy);
    expect(open.stdout.text).toContain("skill text");
  });

  it("has no network", async () => {
    const r = await executor.run(
      `node -e "require('net').connect(53, '1.1.1.1').on('connect', () => process.exit(0)).on('error', (e) => { console.log(e.code); process.exit(1); })"`,
      sandboxed(),
    );
    expect(r.exitCode).toBe(1);
  });

  // Read the name only through osExecutor: with no sandbox, this block is skipped but still runs
  // its registration code (review of 0.16.1: a TypeError there failed the whole file).
  it.runIf(osExecutor?.name === "bwrap")(
    "shows the command only its own processes (0.14, review)",
    async () => {
      // Garuda's own process (this test runner) is not in the sandbox's /proc.
      const r = await executor.run(
        `grep -l [v]itest /proc/[0-9]*/cmdline 2>/dev/null | wc -l`,
        sandboxed(),
      );
      expect(r.stdout.text.trim()).toBe("0");
      const host = await executor.run(
        `grep -l [v]itest /proc/[0-9]*/cmdline 2>/dev/null | wc -l`,
        sandboxed({ sandbox: false }),
      );
      expect(Number(host.stdout.text.trim())).toBeGreaterThan(0);
    },
  );

  it("isolates nothing when the policy says sandbox: false", async () => {
    const r = await executor.run(`echo c > "${outside}/free.txt"`, sandboxed({ sandbox: false }));
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(outside, "free.txt"), "utf8")).toBe("c\n");
  });
});

if (osExecutor !== undefined) executorContract(osExecutor.name, () => osExecutor);
