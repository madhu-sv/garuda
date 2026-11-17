import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectProfiles, isAndroid, profileAccess } from "../src/lang/profiles.js";
import { expandAllowlist, NETWORK_PRESETS } from "../src/net/allowlist.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { parseSettings } from "../src/permissions/settings.js";

/** T14 part 1 (docs/lld/mobile.md): the Android profile. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-android-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function project(content: Record<string, string>): string {
  const root = join(base, `p${n++}`);
  mkdirSync(root, { recursive: true });
  for (const [file, text] of Object.entries(content)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const PLUGINS = 'plugins {\n  id("com.android.application") version "9.1.0" apply false\n}\n';
const CATALOG_APP = "plugins {\n  alias(libs.plugins.android.application)\n}\n";
const LEGACY =
  "buildscript { dependencies { classpath 'com.android.tools.build:gradle:8.5.0' } }\n";

describe("finding an Android project", () => {
  it("by the plugin id, the version catalog's alias, the library plugin or the old classpath", () => {
    expect(isAndroid(project({ "build.gradle.kts": PLUGINS }))).toBe(true);
    expect(
      isAndroid(project({ "settings.gradle.kts": "", "app/build.gradle.kts": CATALOG_APP })),
    ).toBe(true);
    expect(
      isAndroid(
        project({
          "gradle/libs.versions.toml":
            '[plugins]\nandroid-library = { id = "com.android.library" }\n',
        }),
      ),
    ).toBe(true);
    expect(isAndroid(project({ "build.gradle": LEGACY }))).toBe(true);
  });

  it("not a plain JVM project, or Android named elsewhere in the tree", () => {
    expect(isAndroid(project({ "build.gradle.kts": 'plugins { id("java") }\n' }))).toBe(false);
    // No deep scan (N3): a module other than app/ is not read.
    expect(isAndroid(project({ "settings.gradle": "", "feature/build.gradle": PLUGINS }))).toBe(
      false,
    );
  });
});

describe("the Android profile", () => {
  const home = "/home/u";
  const detect = (root: string, env: NodeJS.ProcessEnv = {}) => detectProfiles(root, { home, env });

  it("replaces the Gradle profile: unit tests, a build with no signing, the SDK variables", () => {
    const profiles = detect(project({ "build.gradle.kts": PLUGINS, gradlew: "" }));
    expect(profiles.map((p) => p.id)).toEqual(["android"]);
    const [android] = profiles;
    expect(android).toMatchObject({
      label: "Android (Gradle)",
      test: "./gradlew testDebugUnitTest --offline",
      build: "./gradlew compileDebugSources --offline",
    });
    expect(android?.access.envAllow).toEqual(
      expect.arrayContaining(["JAVA_HOME", "GRADLE_USER_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT"]),
    );
    expect(android?.access.writePaths).toContain(`${home}/.gradle/caches`);
    // The keystore is readable, never writable; nothing else in ~/.android.
    expect(android?.access.readPaths).toEqual([
      `${home}/.android/debug.keystore`,
      `${home}/.android/analytics.settings`,
    ]);
    // The plugin's FakeDependency.jar (the user's Mac check); never the user's daemon registry.
    expect(android?.access.writePaths).toContain(`${home}/.gradle/android`);
    expect(android?.access.writePaths).not.toContain(`${home}/.gradle/daemon`);
    expect(android?.access.writePaths.some((p) => p.includes(".android"))).toBe(false);
    const notes = android?.notes.join("\n") ?? "";
    expect(notes).toContain('"google" and "maven" presets');
    expect(notes).toContain("connectedAndroidTest");
    // A plain Gradle project keeps its profile.
    expect(detect(project({ "build.gradle": "" })).map((p) => p.id)).toEqual(["gradle"]);
    // ANDROID_USER_HOME moves the keystore.
    const moved = detect(project({ "build.gradle": LEGACY }), {
      ANDROID_USER_HOME: "/data/android",
    });
    expect(moved[0]?.access.readPaths).toContain("/data/android/debug.keystore");
  });

  it("the keystore is readable in 'needed' mode only through the profile", () => {
    const fakeHome = join(base, "home");
    mkdirSync(join(fakeHome, ".android"), { recursive: true });
    writeFileSync(join(fakeHome, ".android", "debug.keystore"), "k");
    const root = project({ "build.gradle.kts": PLUGINS });
    const access = profileAccess(detectProfiles(root, { home: fakeHome, env: {} }));
    const engine = (withProfile: boolean) =>
      new PermissionEngine({
        root,
        home: fakeHome,
        approver: new AutoApprover(),
        settings: parseSettings({ sandbox: { reads: "needed" } }),
        ...(withProfile ? { access } : {}),
      });
    const keystore = join(fakeHome, ".android", "debug.keystore");
    const policy = engine(true).execPolicy(1_000);
    expect(policy.reads?.allow).toContain(keystore);
    expect(policy.reads?.allow).not.toContain(join(fakeHome, ".android"));
    // adbkey stays denied, whatever the profile says.
    // (The deny list uses the real home folder; only the path is checked, nothing is read.)
    expect(policy.denyReadPaths).toContain(join(homedir(), ".android", "adbkey"));
    // Without the profile, the keystore is hidden like the rest of the home folder.
    expect(engine(false).execPolicy(1_000).reads?.allow).not.toContain(keystore);
  });
});

describe("the google network preset", () => {
  it("names Google's Maven hosts", () => {
    expect(NETWORK_PRESETS.google).toEqual(["maven.google.com", "dl.google.com"]);
    expect(expandAllowlist(["google", "maven"]).problems).toEqual([]);
    expect(expandAllowlist(["google"]).hosts).toEqual(["maven.google.com", "dl.google.com"]);
  });
});
