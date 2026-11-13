import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectProfiles } from "../src/lang/profiles.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { gradleDaemonPaths, sandboxPaths } from "../src/permissions/sandboxPaths.js";
import { findOsSandbox } from "../src/sandbox/index.js";
import { commandEnv } from "../src/sandbox/process.js";
import { seatbeltProfile } from "../src/sandbox/seatbelt.js";
import type { ExecPolicy } from "../src/sandbox/types.js";

/**
 * T14 (docs/lld/mobile.md): on the user's Mac a sandboxed `./gradlew` handed its build to a daemon
 * that the user had started, and the build wrote in the home folder. The sandbox hides the user's
 * daemon registry and gives Gradle its own.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-gradled-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const policy = (over: Partial<ExecPolicy> = {}): ExecPolicy => ({
  root: base,
  sandbox: true,
  writePaths: [base],
  denyWritePaths: [],
  denyReadPaths: [],
  network: false,
  envAllowlist: [],
  timeoutMs: 10_000,
  maxOutputBytes: 100_000,
  ...over,
});

describe("the registry paths", () => {
  const uid = process.getuid?.() ?? "user";

  it("hides the user's registry (also under a custom GRADLE_USER_HOME); the sandbox's is in temp", () => {
    expect(gradleDaemonPaths("/h", {}, "/t")).toEqual({
      registry: `/t/garuda-gradle-daemon-${uid}`,
      denied: ["/h/.gradle/daemon"],
    });
    expect(gradleDaemonPaths("/h", { GRADLE_USER_HOME: "/g" }, "/t").denied).toEqual([
      "/h/.gradle/daemon",
      "/g/daemon",
    ]);
    // A relative value is ignored, as in the profiles.
    expect(gradleDaemonPaths("/h", { GRADLE_USER_HOME: "g" }, "/t").denied).toEqual([
      "/h/.gradle/daemon",
    ]);
  });

  it("sandboxPaths denies the registry and Kotlin's daemon files; nothing is made in the home folder", () => {
    const home = join(base, "home");
    mkdirSync(join(home, ".gradle"), { recursive: true });
    const paths = sandboxPaths(join(base, "p"), {}, home);
    expect(paths.denyReadPaths).toContain(join(home, ".gradle", "daemon"));
    expect(paths.denyReadPaths).toContain(join(home, "Library/Application Support/kotlin/daemon"));
    expect(paths.denyReadPaths).toContain(join(home, ".local/share/kotlin/daemon"));
    expect(paths.writePaths).not.toContain(join(home, ".gradle", "daemon"));
    // Not writable even under a writable parent: on macOS a read rule does not stop writes (the
    // user's Mac run of this suite). Seatbelt applies the last matching rule, so the write denial
    // must follow the rule that allows the temp folder.
    expect(paths.denyWritePaths).toContain(join(home, ".gradle", "daemon"));
    const profile = seatbeltProfile(
      policy({ writePaths: paths.writePaths, denyWritePaths: paths.denyWritePaths }),
    );
    const daemon = `(subpath "${join(home, ".gradle", "daemon")}")`;
    const lines = profile.split("\n");
    const denial = lines.findIndex((l) => l.startsWith("(deny file-write*") && l.includes(daemon));
    expect(denial).toBeGreaterThan(lines.findIndex((l) => l.startsWith("(allow file-write*")));
    expect(readdirSync(join(home, ".gradle"))).toEqual([]);
    // The sandbox's registry is under a writable temp folder.
    const registry = gradleDaemonPaths(home).registry;
    expect(paths.writePaths.some((w) => registry.startsWith(`${w}/`))).toBe(true);
  });
});

describe("GRADLE_OPTS of a sandboxed command", () => {
  const flag = "-Dorg.gradle.daemon.registry.base=/h/.gradle/garuda-daemon";

  it("names the sandbox's registry, after the proxy's options; not outside the sandbox", () => {
    expect(commandEnv(policy({ gradleRegistry: "/h/.gradle/garuda-daemon" })).GRADLE_OPTS).toBe(
      flag,
    );
    const proxied = commandEnv(
      policy({ gradleRegistry: "/h/.gradle/garuda-daemon", proxy: { port: 4000 } as never }),
    ).GRADLE_OPTS;
    expect(proxied).toContain("-Dhttps.proxyPort=4000");
    expect(proxied?.endsWith(flag)).toBe(true);
    expect(
      commandEnv(policy({ sandbox: false, gradleRegistry: "/h/.gradle/garuda-daemon" }))
        .GRADLE_OPTS,
    ).toBeUndefined();
  });

  it("the engine sets the registry for sandboxed commands only", () => {
    const engine = new PermissionEngine({ root: base, approver: new AutoApprover() });
    expect(engine.execPolicy(1_000).gradleRegistry).toBe(gradleDaemonPaths(homedir()).registry);
    expect(engine.execPolicy(1_000, { sandbox: false }).gradleRegistry).toBeUndefined();
  });
});

describe("the Gradle profile", () => {
  it("no longer opens ~/.gradle/daemon for writes", () => {
    const root = join(base, "gp");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "build.gradle"), "");
    const [gradle] = detectProfiles(root, { home: "/h", env: {} });
    expect(gradle?.access.writePaths).toContain("/h/.gradle/caches");
    expect(gradle?.access.writePaths).not.toContain("/h/.gradle/daemon");
    // Test processes make their working folder here (the user's Mac check).
    expect(gradle?.access.writePaths).toContain("/h/.gradle/workers");
  });
});

// In this machine's sandbox: the denied registry cannot be read or written; the sandbox's own can.
const found = findOsSandbox();
const executor = "executor" in found ? found.executor : undefined;

describe.runIf(executor !== undefined)("the registries in this machine's sandbox", () => {
  it("the user's registry is hidden; the sandbox's own is writable", async () => {
    const home = join(base, "realhome");
    mkdirSync(join(home, ".gradle", "daemon", "8.11.1"), { recursive: true });
    writeFileSync(join(home, ".gradle", "daemon", "8.11.1", "registry.bin"), "token");
    const root = join(base, "rp");
    mkdirSync(root, { recursive: true });
    const paths = sandboxPaths(root, {}, home);
    const run = (command: string) =>
      (executor as NonNullable<typeof executor>).run(
        command,
        policy({
          root,
          writePaths: paths.writePaths,
          denyWritePaths: paths.denyWritePaths,
          denyReadPaths: paths.denyReadPaths,
        }),
      );
    const read = await run(`cat "${home}/.gradle/daemon/8.11.1/registry.bin"`);
    expect(read.exitCode).not.toBe(0);
    expect(read.stdout.text).not.toContain("token");
    const write = await run(`echo x > "${home}/.gradle/daemon/new.bin"`);
    expect(write.exitCode).not.toBe(0);
    const registry = gradleDaemonPaths(home).registry;
    const own = await run(
      `mkdir -p "${registry}" && echo x > "${registry}/registry.bin" && echo ok`,
    );
    expect(own.stdout.text).toContain("ok");
  });
});
