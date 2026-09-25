import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LspClient, LspTimeoutError } from "../src/lsp/client.js";
import { installCommand } from "../src/lsp/install.js";
import {
  configDir,
  findJava,
  JDTLS_BASE_URL,
  JDTLS_INIT_OPTIONS,
  JDTLS_READY,
  JDTLS_VERSION,
  jdtlsHome,
  jdtlsLaunch,
  releaseMajor,
} from "../src/lsp/jdtls.js";
import { LspManager, lspStatusText } from "../src/lsp/manager.js";
import { findServer, languageOf, managedDir } from "../src/lsp/servers.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { findOsSandbox } from "../src/sandbox/index.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-jdtls-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const FAKE = join(import.meta.dirname, "fixtures", "lspServer.mjs");
const found = findOsSandbox();
const osExecutor = "executor" in found ? found.executor : undefined;
const signal = () => new AbortController().signal;

let count = 0;
function folder(name: string): string {
  const dir = join(base, `${name}-${++count}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function file(path: string, text: string, mode = 0o644): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

/** A JDK folder with a `release` file; its java runs the fake server in jdtls mode. */
function jdk(version: string): string {
  const home = folder(`jdk${version}`);
  file(join(home, "release"), `IMPLEMENTOR="Test"\nJAVA_VERSION="${version}"\n`);
  file(join(home, "bin", "java"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" jdtls\n`, 0o755);
  return home;
}

/** A jdtls install folder: bin/jdtls, plugins/ with the launcher, config folders. */
function install(dir = folder("jdtls")): string {
  file(join(dir, "bin", "jdtls"), "#!/usr/bin/env python3\n", 0o755);
  file(join(dir, "plugins", "org.eclipse.equinox.launcher_1.7.0.v2025.jar"), "");
  for (const c of ["config_linux", "config_linux_arm", "config_mac", "config_mac_arm"]) {
    mkdirSync(join(dir, c), { recursive: true });
  }
  return dir;
}

describe("Java: finding jdtls and a Java 21 runtime (0.4)", () => {
  it("maps .java files", () => {
    expect(languageOf("/r/src/main/java/A.java")).toEqual({ language: "java", id: "java" });
  });

  it("reads the major version from a JDK release file", () => {
    expect(releaseMajor('JAVA_VERSION="21.0.2"')).toBe(21);
    expect(releaseMajor('X="1"\nJAVA_VERSION="1.8.0_392"')).toBe(8);
    expect(releaseMajor('JAVA_VERSION="25"')).toBe(25);
    expect(releaseMajor("nothing")).toBeUndefined();
  });

  it("takes the first Java 21 or later: JAVA_HOME, launcher hints, PATH, JDK folders", () => {
    const old = jdk("17.0.9");
    const new21 = jdk("21.0.4");
    const folders = folder("jvms");
    const inFolder = join(folders, "openjdk-25");
    mkdirSync(inFolder);
    file(join(inFolder, "release"), 'JAVA_VERSION="25.0.1"');
    file(join(inFolder, "bin", "java"), "", 0o755);
    const none = { PATH: "" };
    expect(findJava({ env: { ...none, JAVA_HOME: new21 }, jdkFolders: [] })).toEqual({
      java: join(new21, "bin", "java"),
      major: 21,
    });
    expect(findJava({ env: { ...none, JAVA_HOME: old }, jdkFolders: [folders] })?.major).toBe(25);
    expect(findJava({ env: none, hints: [new21], jdkFolders: [] })?.major).toBe(21);
    expect(findJava({ env: { PATH: join(new21, "bin") }, jdkFolders: [] })?.major).toBe(21);
    expect(findJava({ env: { ...none, JAVA_HOME: old }, jdkFolders: [] })).toBeUndefined();
  });

  it("finds the install folder of a Homebrew-style launcher, with its JAVA_HOME hint", () => {
    const prefix = folder("brew");
    install(join(prefix, "libexec"));
    const java = jdk("21.0.1");
    const script = file(
      join(prefix, "bin", "jdtls"),
      `#!/bin/bash\nJAVA_HOME="${java}" exec "${prefix}/libexec/bin/jdtls" "$@"\n`,
      0o755,
    );
    expect(jdtlsHome(script)).toEqual({ home: join(prefix, "libexec"), hints: [java] });
    expect(jdtlsHome(join(folder("empty"), "jdtls"))).toBeUndefined();
  });

  it("picks the config folder for the OS and CPU", () => {
    const dir = install();
    expect(configDir(dir, "darwin", "arm64")).toBe(join(dir, "config_mac_arm"));
    expect(configDir(dir, "darwin", "x64")).toBe(join(dir, "config_mac"));
    expect(configDir(dir, "linux", "x64")).toBe(join(dir, "config_linux"));
  });

  it("builds the java command: shared read-only configuration, state in ~/.cache, one workspace per root", () => {
    const dir = install();
    const java = jdk("21.0.1");
    const home = folder("home");
    const launch = (root: string) =>
      jdtlsLaunch(join(dir, "bin", "jdtls"), {
        root,
        home,
        env: { PATH: "", JAVA_HOME: java },
        jdkFolders: [],
        platform: "linux",
        arch: "x64",
      });
    const a = launch("/projects/a");
    const b = launch("/projects/b");
    if (!("argv" in a) || !("argv" in b)) throw new Error("no argv");
    expect(a.argv[0]).toBe(join(java, "bin", "java"));
    expect(a.argv).toContain(`-Dosgi.sharedConfiguration.area=${join(dir, "config_linux")}`);
    expect(a.argv).toContain("-Dosgi.sharedConfiguration.area.readOnly=true");
    expect(a.argv).toContain(join(dir, "plugins", "org.eclipse.equinox.launcher_1.7.0.v2025.jar"));
    const at = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1] as string;
    expect(at(a.argv, "-configuration").startsWith(join(home, ".cache", "garuda", "jdtls"))).toBe(
      true,
    );
    expect(at(a.argv, "-data")).toMatch(/\.cache\/garuda\/jdtls\/workspace\/[0-9a-f]{16}$/);
    expect(at(a.argv, "-data")).not.toBe(at(b.argv, "-data"));
    expect(at(a.argv, "-configuration")).toBe(at(b.argv, "-configuration"));
  });

  it("says why it cannot start: no Java 21; the status shows it", () => {
    const home = folder("home");
    install(join(managedDir("java", home), "jdtls"));
    const old = jdk("17.0.9");
    const result = findServer("java", {
      root: folder("root"),
      home,
      path: "",
      env: { PATH: "", JAVA_HOME: old },
      jdkFolders: [],
    });
    expect(result.server).toBeUndefined();
    expect(result.problems).toEqual(["jdtls needs Java 21 or later; set JAVA_HOME to such a JDK"]);
    const text = lspStatusText(
      [{ language: "java", state: "missing", problems: result.problems }],
      {
        on: true,
        how: "",
      },
    );
    expect(text).toContain(
      'Java: not found (jdtls needs Java 21 or later; set JAVA_HOME to such a JDK). Run "garuda lsp install java".',
    );
  });

  it("the managed install: the pinned milestone from download.eclipse.org, checked and unpacked", () => {
    const command = installCommand("java", "/h/.garuda/lsp/java");
    expect(command.startsWith("cd /h/.garuda/lsp/java && ")).toBe(true);
    expect(command).toContain(`B=${JDTLS_BASE_URL}`);
    expect(JDTLS_BASE_URL).toBe(`https://download.eclipse.org/jdtls/milestones/${JDTLS_VERSION}`);
    expect(command).toContain('"$B/latest.txt"');
    expect(command).toContain('"$B/$f.sha256"');
    expect(command).toContain("tar -xzf jdtls.tar.gz -C jdtls");
    const home = folder("home");
    install(join(managedDir("java", home), "jdtls"));
    const java = jdk("21.0.1");
    expect(
      findServer("java", {
        root: folder("root"),
        home,
        path: "",
        env: { PATH: "", JAVA_HOME: java },
        jdkFolders: [],
      }).server,
    ).toMatchObject({ spec: { name: "jdtls" }, source: "managed" });
  });
});

describe("Java: the client waits until jdtls has imported the project (0.4)", () => {
  const start = async (options: Partial<Parameters<typeof LspClient.start>[1]>) => {
    const root = folder("client");
    const executor = new HostExecutor();
    const policy = new PermissionEngine({
      root,
      approver: new AutoApprover("deny"),
    }).serverPolicy();
    const process = executor.start([globalThis.process.execPath, FAKE, "jdtls"], {
      ...policy,
      sandbox: false,
    });
    const client = await LspClient.start(process, { root, ...options }, signal());
    return { root, client, executor };
  };

  it("sends the settings, waits for 'Started', then gives the real errors", async () => {
    const { root, client, executor } = await start({
      initializationOptions: JDTLS_INIT_OPTIONS,
      ready: JDTLS_READY,
      firstTimeoutMs: 5_000,
    });
    const items = await client.diagnostics(
      join(root, "A.java"),
      "java",
      "int x = ERROR;\n",
      signal(),
    );
    expect(items.map((d) => d.message)).toEqual(["error here\nsecond line"]);
    await client.close();
    executor.shutdown();
  });

  it("without the settings the server refuses to start", async () => {
    await expect(start({ ready: JDTLS_READY, firstTimeoutMs: 2_000 })).rejects.toThrow();
  });

  it("a server that is not ready in time: one wait, then no more waits", async () => {
    const { root, client, executor } = await start({
      initializationOptions: JDTLS_INIT_OPTIONS,
      ready: { method: "language/status", test: () => false },
      firstTimeoutMs: 100,
    });
    const file = join(root, "A.java");
    await expect(client.diagnostics(file, "java", "x", signal())).rejects.toBeInstanceOf(
      LspTimeoutError,
    );
    const t0 = Date.now();
    await expect(client.diagnostics(file, "java", "y", signal())).rejects.toBeInstanceOf(
      LspTimeoutError,
    );
    expect(Date.now() - t0).toBeLessThan(50);
    await client.close();
    executor.shutdown();
  });
});

describe.runIf(osExecutor !== undefined)("Java: jdtls in the OS sandbox (fake java) (0.4)", () => {
  it("a warm start at the turn, then the errors of an edited .java file", async () => {
    const executor = osExecutor as NonNullable<typeof osExecutor>;
    const root = folder("project");
    const home = folder("home");
    install(join(managedDir("java", home), "jdtls"));
    const java = jdk("21.0.1");
    const manager = new LspManager({
      root,
      executor,
      policy: () =>
        new PermissionEngine({
          root,
          approver: new AutoApprover("deny"),
          isolation: executor.isolation,
        }).serverPolicy(),
      home,
      path: "",
      env: { PATH: "", JAVA_HOME: java },
      jdkFolders: [],
    });
    manager.warm("java");
    expect(manager.status()[2]).toMatchObject({ language: "java", state: "starting" });
    const text = await manager.diagnostics(
      join(root, "A.java"),
      "A.java",
      "class A {\n  int x = ERROR;\n}\n",
      signal(),
    );
    expect(text).toBe("1 error in A.java after this change (jdtls):\n  2:11 error here [X2]");
    expect(manager.status()[2]).toMatchObject({ state: "running", server: { source: "managed" } });
    await manager.close();
  });
});

// The real jdtls, when it is installed (garuda lsp install java, or brew install jdtls). It takes
// 20–60 s, so it runs only on request: GARUDA_TEST_JDTLS=1 pnpm vitest run test/lsp.java.test.ts
describe.runIf(osExecutor !== undefined && process.env.GARUDA_TEST_JDTLS === "1")(
  "Java: the real jdtls (opt-in) (0.4)",
  () => {
    it("finds a type error in a Java file, and its fix", async () => {
      const executor = osExecutor as NonNullable<typeof osExecutor>;
      const root = folder("real");
      const policy = () =>
        new PermissionEngine({
          root,
          approver: new AutoApprover("deny"),
          isolation: executor.isolation,
        }).serverPolicy();
      const notices: string[] = [];
      const manager = new LspManager({ root, executor, policy, notify: (t) => notices.push(t) });
      const file = join(root, "Demo.java");
      const bad = 'public class Demo {\n  int total = "ten";\n}\n';
      // The tools write the file before the check; jdtls reads the folder from disk.
      writeFileSync(file, bad);
      const text = await manager.diagnostics(file, "Demo.java", bad, signal());
      expect(notices).toEqual([]);
      expect(text).toMatch(
        /^1 error in Demo\.java after this change \(jdtls\):\n {2}2:15 Type mismatch/,
      );
      const good = "public class Demo {\n  int total = 10;\n}\n";
      writeFileSync(file, good);
      expect(await manager.diagnostics(file, "Demo.java", good, signal())).toBe(
        "No errors in Demo.java (jdtls).",
      );
      await manager.close();
    }, 180_000);
  },
);
