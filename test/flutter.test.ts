import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isTestCommand, parseTestCount } from "../src/app/receipt.js";
import { detectProfiles, flutterSdk } from "../src/lang/profiles.js";
import { NETWORK_PRESETS, presetFor } from "../src/net/allowlist.js";

/** T14 part 3 (docs/lld/mobile.md): the Flutter profile, from the user's probes (Flutter 3.50.1). */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-flutter-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;

const FLUTTER_APP = `name: shop
environment:
  sdk: ">=3.0.0 <4.0.0"
dependencies:
  flutter:
    sdk: flutter
dev_dependencies:
  flutter_test:
    sdk: flutter
flutter:
  uses-material-design: true
`;

function project(pubspec: string, extra: string[] = []): string {
  const root = join(base, `p${n++}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "pubspec.yaml"), pubspec);
  for (const f of extra) writeFileSync(join(root, f), "");
  return root;
}

/** A Flutter SDK folder: what `flutterSdk` checks is bin/flutter and packages/flutter_tools. */
function sdkAt(dir: string): string {
  mkdirSync(join(dir, "bin", "cache"), { recursive: true });
  mkdirSync(join(dir, "packages", "flutter_tools"), { recursive: true });
  writeFileSync(join(dir, "bin", "flutter"), "#!/bin/sh\n");
  return realpathSync(dir);
}

const HOME = "/Users/u";
const detect = (root: string, env: NodeJS.ProcessEnv = {}) =>
  detectProfiles(root, { home: HOME, env, platform: "darwin", tempDir: "/var/folders/ab/cd/T" });

const PUB_DIRS = ["hosted", "hosted-hashes", "active_roots", "git", "_temp"].map((d) =>
  join(HOME, ".pub-cache", d),
);

describe("the Flutter profile", () => {
  it("a pubspec with a flutter section or a flutter dependency; a Dart package is not Flutter", () => {
    const [app] = detect(project(FLUTTER_APP));
    expect(app).toMatchObject({ id: "flutter", label: "Flutter", test: "flutter test" });
    // `flutter build` needs a platform toolchain; the notes name `flutter analyze` instead.
    expect(app?.build).toBeUndefined();
    expect(app?.notes.join("\n")).toContain("flutter analyze");
    // A package that only depends on Flutter, with no flutter: section.
    const pkg = "name: widgets\ndependencies:\n  flutter:\n    sdk: flutter\n";
    expect(detect(project(pkg))[0]?.id).toBe("flutter");
    // A plain Dart package: no profile (dart test is not part of this one).
    expect(detect(project("name: util\ndependencies:\n  path: ^1.9.0\n"))).toEqual([]);
  });

  it("writes only the pub cache's package folders and two files of the SDK, never its tool", () => {
    const sdk = sdkAt(join(base, "flutter-sdk"));
    const [app] = detect(project(FLUTTER_APP), { FLUTTER_ROOT: sdk });
    expect(app?.access.writePaths).toEqual([
      ...PUB_DIRS,
      join(sdk, "bin", "cache", "lockfile"),
      join(sdk, "bin", "cache", "engine.realm"),
    ]);
    const writes = app?.access.writePaths ?? [];
    // bin/cache holds the Flutter tool and the Dart SDK, which run outside the sandbox later.
    expect(writes).not.toContain(join(sdk, "bin", "cache"));
    expect(writes).not.toContain(sdk);
    // The pub cache's root, its executables and its credentials stay out.
    for (const p of ["", "bin", "global_packages", "credentials.json"]) {
      expect(writes).not.toContain(join(HOME, ".pub-cache", p));
    }
    // An SDK in the home folder is hidden in "needed" mode: the profile reads it.
    expect(app?.access.readPaths).toEqual([sdk]);
    expect(app?.access.envAllow).toEqual([
      "FLUTTER_ROOT",
      "PUB_CACHE",
      "PUB_HOSTED_URL",
      "FLUTTER_STORAGE_BASE_URL",
    ]);
  });

  it("finds the SDK from flutter on PATH through Homebrew's link, as a real path", () => {
    // /opt/homebrew/bin/flutter -> /opt/homebrew/share/flutter/bin/flutter (the user's Mac).
    const share = sdkAt(join(base, "brew", "share", "flutter"));
    mkdirSync(join(base, "brew", "bin"), { recursive: true });
    symlinkSync(join(share, "bin", "flutter"), join(base, "brew", "bin", "flutter"));
    const env = { PATH: ["/nowhere", join(base, "brew", "bin")].join(":") };
    expect(flutterSdk(env)).toBe(share);
    // FLUTTER_ROOT wins over PATH. One that is not an SDK, or not absolute, does not count: a
    // FLUTTER_ROOT of /opt/homebrew has bin/flutter (the link) but is not the SDK.
    const other = sdkAt(join(base, "other-sdk"));
    expect(flutterSdk({ ...env, FLUTTER_ROOT: other })).toBe(other);
    expect(flutterSdk({ ...env, FLUTTER_ROOT: join(base, "brew") })).toBe(share);
    expect(flutterSdk({ ...env, FLUTTER_ROOT: "flutter" })).toBe(share);
  });

  it("without an SDK: the pub cache only, and a note that says why flutter may fail", () => {
    const [app] = detect(project(FLUTTER_APP), { PATH: "/nowhere" });
    expect(app?.access.writePaths).toEqual(PUB_DIRS);
    expect(app?.access.readPaths).toBeUndefined();
    expect(app?.notes.join("\n")).toContain("Flutter was not found");
    // With an SDK there is no such note.
    const sdk = sdkAt(join(base, "sdk2"));
    expect(detect(project(FLUTTER_APP), { FLUTTER_ROOT: sdk })[0]?.notes.join("\n")).not.toContain(
      "Flutter was not found",
    );
  });

  it("PUB_CACHE moves the cache when it is absolute", () => {
    const [moved] = detect(project(FLUTTER_APP), { PUB_CACHE: "/data/pub" });
    expect(moved?.access.writePaths).toContain("/data/pub/hosted");
    const [relative] = detect(project(FLUTTER_APP), { PUB_CACHE: "pub" });
    expect(relative?.access.writePaths).toContain(join(HOME, ".pub-cache", "hosted"));
  });

  it("the notes: tests in the sandbox; devices outside, with a yes; the engine.stamp line", () => {
    const notes = detect(project(FLUTTER_APP))[0]?.notes.join("\n") ?? "";
    expect(notes).toContain("flutter pub get --offline");
    expect(notes).toContain('"pub" preset');
    expect(notes).toContain("only outside the sandbox, with the user's yes");
    expect(notes).toContain("engine.stamp");
    expect(notes).toContain("flutter upgrade");
  });

  it("comes before Python when a project has both", () => {
    expect(detect(project(FLUTTER_APP, ["requirements.txt"])).map((p) => p.id)).toEqual([
      "flutter",
      "python",
    ]);
  });
});

describe("the pub network preset", () => {
  it("names pub.dev and the archives' host", () => {
    expect(NETWORK_PRESETS.pub).toEqual(["pub.dev", "storage.googleapis.com"]);
    expect(presetFor("pub.dev")).toBe("pub");
  });
});

/** The user's `flutter test --no-pub` on their Mac (the probe), cut. */
const FLUTTER_PASS = [
  "00:00 +0: loading /private/var/folders/qc/x/T/tmp.A6/flutter_probe/test/cart_test.dart",
  "00:00 +0: the subtotal counts quantities",
  "00:00 +1: a widget renders in the headless engine",
  "00:00 +2: All tests passed!",
].join("\n");

describe("the receipt reads flutter test", () => {
  it("knows flutter test and dart test as test commands", () => {
    expect(isTestCommand("flutter test", undefined)).toBe(true);
    expect(isTestCommand("flutter test test/cart_test.dart --plain-name total", undefined)).toBe(
      true,
    );
    expect(isTestCommand("dart test", undefined)).toBe(true);
    expect(isTestCommand("flutter analyze", undefined)).toBe(false);
    expect(isTestCommand("flutter pub get --offline", undefined)).toBe(false);
  });

  it("counts from the last counter line: + passed, - failed; ~ skipped does not count", () => {
    expect(parseTestCount(FLUTTER_PASS)).toEqual({ total: 2, failed: 0 });
    const failed = [
      "00:01 +2: the subtotal counts quantities",
      "00:01 +2 -1: free shipping [E]",
      "  Expected: <0>",
      "00:02 +3 -1: Some tests failed.",
    ].join("\n");
    expect(parseTestCount(failed)).toEqual({ total: 4, failed: 1 });
    expect(parseTestCount("00:00 +2 ~1: All tests passed!")).toEqual({ total: 2, failed: 0 });
    // Only skipped tests: none ran, so the receipt says "no tests ran", not "passed".
    expect(parseTestCount("00:00 +0 ~2: All tests skipped.")).toEqual({ total: 0, failed: 0 });
  });
});
