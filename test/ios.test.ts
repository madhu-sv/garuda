import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isTestCommand, parseTestCount, ReceiptCollector } from "../src/app/receipt.js";
import { clangModuleCache, detectProfiles } from "../src/lang/profiles.js";

/** T14 part 2 (docs/lld/mobile.md): Swift packages and Xcode projects, from the user's iOS check. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-ios-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
function project(files: string[], dirs: string[] = []): string {
  const root = join(base, `p${n++}`);
  mkdirSync(root, { recursive: true });
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  for (const f of files) writeFileSync(join(root, f), "");
  return root;
}
const detect = (root: string, platform: NodeJS.Platform = "darwin") =>
  detectProfiles(root, { home: "/Users/u", env: {}, platform, tempDir: "/var/folders/ab/cd/T" });

describe("the profiles", () => {
  it("a Swift package: swift test and build with --disable-sandbox, in the sandbox", () => {
    const [swift] = detect(project(["Package.swift"]));
    expect(swift).toMatchObject({
      id: "swift",
      test: "swift test --disable-sandbox",
      build: "swift build --disable-sandbox",
    });
    expect(swift?.access.envAllow).toContain("DEVELOPER_DIR");
    expect(swift?.notes.join("\n")).toContain("SwiftPM's own sandbox");
  });

  it("an Xcode project: a build for the simulator in the sandbox; tests only outside, with a yes", () => {
    const [xcode] = detect(project([], ["Shop.xcodeproj"]));
    expect(xcode?.id).toBe("xcode");
    expect(xcode?.build).toBe(
      "xcodebuild build -project Shop.xcodeproj -scheme Shop -destination 'generic/platform=iOS Simulator' -derivedDataPath .build/xcode -skipPackagePluginValidation -skipMacroValidation -IDEPackageSupportDisableManifestSandbox=YES CODE_SIGNING_ALLOWED=NO",
    );
    expect(xcode?.test).toContain("-destination 'platform=iOS Simulator,name=<device>'");
    const notes = xcode?.notes.join("\n") ?? "";
    expect(notes).toContain("outside_sandbox: true; the user must approve");
    expect(notes).toContain("xcodebuild -list -project Shop.xcodeproj");
    // A workspace wins over a project (CocoaPods and SwiftPM setups build through it).
    expect(detect(project([], ["Shop.xcodeproj", "Shop.xcworkspace"]))[0]?.build).toContain(
      "-workspace Shop.xcworkspace -scheme Shop",
    );
  });

  it("both: the package first, so jobs and the tour run tests that work in the sandbox", () => {
    expect(detect(project(["Package.swift"], ["App.xcodeproj"])).map((p) => p.id)).toEqual([
      "swift",
      "xcode",
    ]);
    expect(detect(project(["Package.swift"])).map((p) => p.id)).toEqual(["swift"]);
  });

  it("clang's module cache on macOS: the temp folder's sibling C, as a real path; none elsewhere", () => {
    expect(clangModuleCache("darwin", "/var/folders/ab/cd/T")).toEqual([
      "/var/folders/ab/cd/C/clang/ModuleCache",
    ]);
    expect(clangModuleCache("darwin", "/custom/tmp")).toEqual([]);
    expect(clangModuleCache("linux", "/var/folders/ab/cd/T")).toEqual([]);
    expect(detect(project(["Package.swift"]))[0]?.access.writePaths).toEqual([
      "/var/folders/ab/cd/C/clang/ModuleCache",
    ]);
    expect(detect(project(["Package.swift"]), "linux")[0]?.access.writePaths).toEqual([]);
    // A temp folder through a link counts as its real path (Seatbelt: /private/var).
    mkdirSync(join(base, "private", "folders", "T"), { recursive: true });
    symlinkSync(join(base, "private", "folders"), join(base, "folders"), "dir");
    expect(clangModuleCache("darwin", join(base, "folders", "T"))).toEqual([
      join(base, "private", "folders", "C", "clang", "ModuleCache"),
    ]);
  });
});

/** The user's `swift test --disable-sandbox` in the sandbox, cut. */
const SWIFT_TEST = [
  "Test Suite 'All tests' started at 2026-11-17 13:51:49.331.",
  "Test Case '-[ProbeTests.CalcTests testAdds]' passed (0.000 seconds).",
  "\t Executed 1 test, with 0 failures (0 unexpected) in 0.000 (0.000) seconds",
  "Test Suite 'ProbeTests.xctest' passed at 2026-11-17 13:51:49.332.",
  "\t Executed 1 test, with 0 failures (0 unexpected) in 0.000 (0.000) seconds",
  "Test Suite 'All tests' passed at 2026-11-17 13:51:49.332.",
  "\t Executed 1 test, with 0 failures (0 unexpected) in 0.000 (0.001) seconds",
  "◇ Test run started.",
  "✔ Test run with 0 tests in 0 suites passed after 0.001 seconds.",
].join("\n");

describe("the receipt for Swift and Xcode tests", () => {
  it("knows swift test and xcodebuild test, not a build", () => {
    expect(isTestCommand("swift test --disable-sandbox", undefined)).toBe(true);
    expect(isTestCommand("xcodebuild test -scheme Shop -destination x", undefined)).toBe(true);
    expect(isTestCommand("xcodebuild test-without-building -scheme Shop", undefined)).toBe(true);
    expect(isTestCommand("xcodebuild build -scheme Shop", undefined)).toBe(false);
    expect(isTestCommand("xcodebuild build-for-testing -scheme Shop", undefined)).toBe(false);
    // A word that ends in "test" is not the test action.
    expect(isTestCommand("xcodebuild build -scheme latest", undefined)).toBe(false);
  });

  it("counts XCTest and Swift Testing together: the probe ran 1 test, not 0", () => {
    expect(parseTestCount(SWIFT_TEST)).toEqual({ total: 1, failed: 0 });
    expect(
      parseTestCount("\t Executed 5 tests, with 1 failure (0 unexpected) in 0.1 (0.1) seconds"),
    ).toEqual({ total: 5, failed: 1 });
    expect(
      parseTestCount(
        "✘ Test run with 3 tests in 1 suite failed after 0.002 seconds with 2 issues.",
      ),
    ).toEqual({ total: 3, failed: 2 });
    const c = new ReceiptCollector(undefined);
    c.add(
      "swift test --disable-sandbox",
      { exitCode: 0, timedOut: false, sandboxed: true, blockedHosts: [] },
      SWIFT_TEST,
    );
    expect(c.tests).toEqual({
      command: "swift test --disable-sandbox",
      passed: true,
      total: 1,
      failed: 0,
    });
  });
});
