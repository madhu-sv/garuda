import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";

/**
 * Language profiles (0.3). Garuda looks at marker files in the working root (no deep scan, so
 * startup stays fast, N3) and finds the build tool of the project. A profile gives:
 *
 * - `test` and `build`: the commands for this project, run in the working root.
 * - `notes`: short lines for the system prompt, so the model uses the right commands.
 * - `access`: package caches that commands in the sandbox may write, and environment variables
 *   that commands may see. Only caches: settings files and init scripts stay read-only,
 *   because the build tool reads or runs them later, outside the sandbox.
 *
 * The profiles do not start hooks and do not install anything.
 */

export type ProfileId = "maven" | "gradle" | "android" | "swift" | "xcode" | "flutter" | "python";

export interface LanguageProfile {
  id: ProfileId;
  /** For people, for example "Java (Maven)". */
  label: string;
  test: string;
  build?: string;
  notes: string[];
  access: ProfileAccess;
}

export interface ProfileAccess {
  /** Absolute paths that sandboxed commands may write. */
  writePaths: string[];
  /** Environment variables that commands may see. */
  envAllow: string[];
  /**
   * Absolute paths that sandboxed commands may read in "needed" mode (T14): files outside the
   * project and the toolchain folders that a build reads, such as Android's debug keystore.
   */
  readPaths?: string[];
}

export interface DetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** For tests: the platform and the temp folder (macOS: the per-user cache folder is its sibling). */
  platform?: NodeJS.Platform;
  tempDir?: string;
}

const MAVEN_MARKERS = ["pom.xml"];
const GRADLE_MARKERS = [
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
];
const PYTHON_MARKERS = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "pytest.ini",
  "tox.ini",
  "Pipfile",
];

/** Environment variables that Java and Python tools read to find themselves. No secrets. */
const JAVA_ENV = ["JAVA_HOME"];
const GRADLE_ENV = ["JAVA_HOME", "GRADLE_USER_HOME"];
const ANDROID_ENV = [...GRADLE_ENV, "ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_USER_HOME"];

/** The build files that name the Android Gradle plugin, at the root and in `app/`. */
const ANDROID_FILES = [
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "app/build.gradle",
  "app/build.gradle.kts",
  "gradle/libs.versions.toml",
];
/** The plugin ids, the version catalog's aliases and the old buildscript classpath. */
const ANDROID_PLUGIN =
  /com\.android\.(application|library|tools\.build)|plugins\.android\.(application|library)\b/;

/** True when one of a few build files names the Android Gradle plugin (no deep scan, N3). */
export function isAndroid(root: string): boolean {
  for (const name of ANDROID_FILES) {
    try {
      if (ANDROID_PLUGIN.test(readFileSync(join(root, name), "utf8").slice(0, 200_000)))
        return true;
    } catch {
      // Not there.
    }
  }
  return false;
}
const PYTHON_ENV = ["VIRTUAL_ENV"];
/** Flutter's own folders and its mirrors' settings (T14 part 3). No secrets. */
const FLUTTER_ENV = [
  "FLUTTER_ROOT",
  "PUB_CACHE",
  "PUB_HOSTED_URL",
  "FLUTTER_STORAGE_BASE_URL",
  // Flutter keeps its settings in $XDG_CONFIG_HOME/flutter when it is set: the same folder inside
  // the sandbox as outside.
  "XDG_CONFIG_HOME",
];
/**
 * Flutter's settings and telemetry in the home folder, readable in "needed" mode, never writable.
 * Without them the tool sees no settings folder, tries to create ~/.config/flutter and stops (the
 * user's Mac, in the sandbox). The settings name the JDK and the Android SDK that later runs use,
 * outside the sandbox too, so they stay read-only. `.flutter_settings` and `.flutter_tool_state`
 * are older places that Flutter checks first; `.flutter` holds older telemetry.
 */
const FLUTTER_HOME_READS = [".flutter_settings", ".flutter_tool_state", ".flutter", ".dart-tool"];
/**
 * The two telemetry files that every `flutter` command writes (the user's probes). Without them the
 * tool stopped in the sandbox: "Failed to set file modification time" on the session file, while it
 * reported an error. Neither holds code or settings. The consent file
 * (`dart-flutter-telemetry.config`) stays read-only, so the sandbox cannot turn telemetry on.
 */
const FLUTTER_TELEMETRY_WRITES = [
  ".dart-tool/dart-flutter-telemetry-session.json",
  ".dart-tool/dart-flutter-telemetry.log",
];

/**
 * The caches under the home folder that builds write. Only these subfolders: for example
 * ~/.m2/settings.xml and ~/.gradle/init.d stay read-only.
 */
const MAVEN_CACHES = [".m2/repository", ".m2/wrapper"];
// Not "daemon": the user's daemon registry stays hidden from the sandbox, which has its own (T14).
// "workers": a test process makes its working folder there (the user's Mac check, T14).
const GRADLE_CACHES = ["caches", "wrapper", "native", "jdks", ".tmp", "notifications", "workers"];
/**
 * The pub cache's package folders (T14 part 3): the packages, their hashes, the projects that use
 * them, git dependencies and pub's download folder. Not `bin` or `global_packages` (executables that
 * run outside the sandbox later), and not `credentials.json`, which stays denied.
 */
const PUB_CACHE_DIRS = ["hosted", "hosted-hashes", "active_roots", "git", "_temp"];
/**
 * The files in the Flutter SDK that every `flutter` command writes (the user's Mac, Flutter
 * 3.50.1): the startup lock and the engine realm. Neither holds code, and the startup script
 * rewrites the realm on every run (from FLUTTER_REALM), so a write from the sandbox cannot last.
 * Not `bin/cache` as a whole: it holds the Flutter tool and the Dart SDK, which run outside the
 * sandbox later. The script also writes `engine.stamp` through a temporary file in `bin/cache`;
 * that write fails in the sandbox, and the script goes on (`&&`) with the stamp it has.
 */
const FLUTTER_SDK_FILES = ["bin/cache/lockfile", "bin/cache/engine.realm"];
/** pip and uv caches are under ~/.cache and ~/Library/Caches, which every profile may write. */
const PYTHON_CACHES = [".local/share/uv"];

/** Profiles for the project in `root`, in a fixed order. Empty when nothing matches. */
export function detectProfiles(root: string, options: DetectOptions = {}): LanguageProfile[] {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const has = (name: string) => existsSync(join(root, name));
  const profiles: LanguageProfile[] = [];

  if (MAVEN_MARKERS.some(has)) {
    const mvn = has("mvnw") ? "./mvnw" : "mvn";
    profiles.push({
      id: "maven",
      label: "Java (Maven)",
      test: `${mvn} -B -q -o test`,
      build: `${mvn} -B -q -o compile`,
      notes: [
        `Java project with Maven (pom.xml). Run the tests with \`${mvn} -B -q -o test\`; one test class: \`${mvn} -B -q -o test -Dtest=ClassName\`.`,
        "Sources are in src/main/java and tests in src/test/java. The package path must match the folder path.",
        "-o (offline) uses the downloaded dependencies in ~/.m2. If Maven reports a missing dependency, run the",
        "same command without -o and with outside_sandbox: true, so the user can approve the download.",
      ],
      access: {
        writePaths: MAVEN_CACHES.map((p) => join(home, p)),
        envAllow: JAVA_ENV,
      },
    });
  }

  if (GRADLE_MARKERS.some(has) && isAndroid(root)) {
    const gradle = has("gradlew") ? "./gradlew" : "gradle";
    const gradleHome = userHome(env.GRADLE_USER_HOME, join(home, ".gradle"));
    const androidHome = userHome(env.ANDROID_USER_HOME, join(home, ".android"));
    profiles.push({
      id: "android",
      label: "Android (Gradle)",
      test: `${gradle} testDebugUnitTest --offline`,
      build: `${gradle} compileDebugSources --offline`,
      notes: [
        `Android project with Gradle. Run the unit tests with \`${gradle} testDebugUnitTest --offline\`; one test`,
        `class: \`${gradle} testDebugUnitTest --offline --tests 'com.example.FooTest'\`. Compile with`,
        `\`${gradle} compileDebugSources --offline\`. --offline uses the downloaded dependencies. If Gradle`,
        'reports a missing dependency, ask the user to add the "google" and "maven" presets to the network',
        "allowlist, or run the command without --offline and with outside_sandbox: true.",
        "Instrumented tests (connectedAndroidTest), the emulator and adb need a device: they run only",
        "outside the sandbox, with the user's yes. Prefer unit tests. Do not change ~/.android.",
      ],
      access: {
        // `android`: the plugin's FakeDependency.jar (the user's Mac check).
        writePaths: [...GRADLE_CACHES, "android"].map((p) => join(gradleHome, p)),
        envAllow: ANDROID_ENV,
        // The debug build signs with the keystore; the plugin reads its analytics settings. The
        // sandbox never writes ~/.android (docs/lld/mobile.md).
        readPaths: [join(androidHome, "debug.keystore"), join(androidHome, "analytics.settings")],
      },
    });
  } else if (GRADLE_MARKERS.some(has)) {
    const gradle = has("gradlew") ? "./gradlew" : "gradle";
    const gradleHome = userHome(env.GRADLE_USER_HOME, join(home, ".gradle"));
    profiles.push({
      id: "gradle",
      label: "Java (Gradle)",
      test: `${gradle} test --offline -q`,
      build: `${gradle} build -x test --offline -q`,
      notes: [
        `Java project with Gradle. Run the tests with \`${gradle} test --offline -q\`; one test class:`,
        `\`${gradle} test --offline -q --tests ClassName\`. --offline uses the downloaded dependencies. If Gradle`,
        "reports a missing dependency, run the command without --offline and with outside_sandbox: true.",
      ],
      access: {
        writePaths: GRADLE_CACHES.map((p) => join(gradleHome, p)),
        envAllow: GRADLE_ENV,
      },
    });
  }

  // Swift and Xcode (T14 part 2, docs/lld/mobile.md). A Swift package's tests run in the sandbox;
  // an Xcode project's tests need the iOS simulator, which the sandbox blocks, so a package comes
  // first when a project has both.
  const xcode = xcodeProjects(root);
  const swiftAccess = (): ProfileAccess => ({
    writePaths: clangModuleCache(options.platform ?? process.platform, options.tempDir ?? tmpdir()),
    envAllow: ["DEVELOPER_DIR"],
  });
  if (has("Package.swift")) {
    profiles.push({
      id: "swift",
      label: "Swift (SwiftPM)",
      test: "swift test --disable-sandbox",
      build: "swift build --disable-sandbox",
      notes: [
        "Swift package. Run the tests with `swift test --disable-sandbox`; one test:",
        "`swift test --disable-sandbox --filter Module.Class/testName`. Build with `swift build --disable-sandbox`.",
        "--disable-sandbox turns off SwiftPM's own sandbox, which cannot start inside Garuda's (Garuda's",
        "is stricter). `swift test` runs on macOS: a package that needs iOS APIs (UIKit) tests with",
        "xcodebuild and the iOS simulator instead, which runs only with outside_sandbox: true and the",
        "user's yes. The first build fetches the dependencies: it needs the network (ask the user).",
      ],
      access: swiftAccess(),
    });
  }
  if (xcode.length > 0) {
    const project = xcode[0] ?? "";
    const scheme = basename(project).replace(/\.(xcodeproj|xcworkspace)$/, "");
    const flag = project.endsWith(".xcworkspace") ? `-workspace ${project}` : `-project ${project}`;
    const build = `xcodebuild build ${flag} -scheme ${scheme} -destination 'generic/platform=iOS Simulator' -derivedDataPath .build/xcode -skipPackagePluginValidation -skipMacroValidation -IDEPackageSupportDisableManifestSandbox=YES CODE_SIGNING_ALLOWED=NO`;
    const test = `xcodebuild test ${flag} -scheme ${scheme} -destination 'platform=iOS Simulator,name=<device>' -derivedDataPath .build/xcode`;
    profiles.push({
      id: "xcode",
      label: "iOS (Xcode)",
      test,
      build,
      notes: [
        `Xcode project (${project}). List the schemes with \`xcodebuild -list ${flag}\`; "${scheme}" is a guess.`,
        `Build for the simulator in the sandbox with \`${build}\`.`,
        "The derived data stays in .build/xcode, in the project (add it to .gitignore). Code signing is off.",
        "Tests need the iOS simulator, which the sandbox blocks: run",
        `\`${test}\` with outside_sandbox: true; the user must approve. Pick the`,
        "device from `xcrun simctl list devices available`, also outside the sandbox.",
      ],
      access: swiftAccess(),
    });
  }

  // Flutter (T14 part 3, docs/lld/mobile.md): `flutter test` runs in the headless engine on the
  // computer, so it needs no device and runs in the sandbox.
  if (has("pubspec.yaml") && isFlutter(root)) {
    const sdk = flutterSdk(env);
    const pubCache = userHome(env.PUB_CACHE, join(home, ".pub-cache"));
    profiles.push({
      id: "flutter",
      label: "Flutter",
      test: "flutter test",
      notes: [
        "Flutter project (pubspec.yaml). Run the tests with `flutter test`; one file: `flutter test test/x_test.dart`;",
        "one test: `flutter test --plain-name 'name'`. Check the code with `flutter analyze`.",
        "The packages come from the pub cache: `flutter pub get --offline`. If a package is missing, ask the user",
        'to add the "pub" preset to the network allowlist, or run `flutter pub get` with outside_sandbox: true.',
        "flutter run, drive, install, attach and screenshot, and the tests in integration_test/, need a simulator,",
        "emulator or device: they run only outside the sandbox, with the user's yes. Prefer `flutter test`.",
        "Each flutter command tries to update bin/cache/engine.stamp in the Flutter SDK, which the sandbox does",
        "not let it write: an error line about engine.stamp is expected and harmless. After `flutter upgrade`,",
        "the first flutter command must run outside the sandbox: it rebuilds the Flutter tool in the SDK.",
        ...(sdk === undefined
          ? [
              "Flutter was not found (FLUTTER_ROOT, or `flutter` on PATH), so the SDK's lock file is not writable",
              "and flutter commands may fail in the sandbox. Ask the user how they run Flutter.",
            ]
          : []),
      ],
      access: {
        writePaths: [
          ...PUB_CACHE_DIRS.map((p) => join(pubCache, p)),
          ...(sdk === undefined ? [] : FLUTTER_SDK_FILES.map((f) => join(sdk, f))),
          ...FLUTTER_TELEMETRY_WRITES.map((f) => join(home, f)),
        ],
        envAllow: FLUTTER_ENV,
        // An SDK in the home folder (~/development/flutter) is hidden in "needed" mode, as are
        // Flutter's settings and telemetry.
        readPaths: [
          ...(sdk === undefined ? [] : [sdk]),
          join(userHome(env.XDG_CONFIG_HOME, join(home, ".config")), "flutter"),
          ...FLUTTER_HOME_READS.map((p) => join(home, p)),
        ],
      },
    });
  }

  if (PYTHON_MARKERS.some(has)) {
    const runner = pythonRunner(root, has);
    profiles.push({
      id: "python",
      label: "Python",
      test: `${runner} -m pytest -q`,
      notes: [
        `Python project. Run the tests with \`${runner} -m pytest -q\`; one test: \`${runner} -m pytest -q path/test_x.py::test_name\`.`,
        ...(has("uv.lock")
          ? ["The project uses uv (uv.lock). Do not change uv.lock by hand."]
          : []),
        "Do not install packages in the sandbox: it has no network. Ask the user first.",
      ],
      access: {
        writePaths: PYTHON_CACHES.map((p) => join(home, p)),
        envAllow: PYTHON_ENV,
      },
    });
  }

  return profiles;
}

/** A pubspec.yaml with a `flutter:` section or a `sdk: flutter` dependency (a Dart package has neither). */
function isFlutter(root: string): boolean {
  try {
    const text = readFileSync(join(root, "pubspec.yaml"), "utf8").slice(0, 200_000);
    return /^flutter:/m.test(text) || /^\s+sdk:\s*["']?flutter\b/m.test(text);
  } catch {
    return false;
  }
}

/**
 * The Flutter SDK as a real path (Seatbelt compares real paths): FLUTTER_ROOT, else the `flutter` on
 * PATH, two folders up from its real path (Homebrew: /opt/homebrew/bin/flutter is a link into
 * /opt/homebrew/share/flutter/bin). An SDK has bin/flutter and packages/flutter_tools. Undefined when
 * neither is a Flutter SDK.
 */
export function flutterSdk(env: NodeJS.ProcessEnv): string | undefined {
  const sdk = (dir: string): string | undefined => {
    try {
      const real = realpathSync(dir);
      // bin/flutter alone is not enough: /opt/homebrew has one too (a link into the SDK).
      const isSdk =
        existsSync(join(real, "bin", "flutter")) &&
        existsSync(join(real, "packages", "flutter_tools"));
      return isSdk ? real : undefined;
    } catch {
      return undefined;
    }
  };
  if (env.FLUTTER_ROOT !== undefined && isAbsolute(env.FLUTTER_ROOT)) {
    const found = sdk(env.FLUTTER_ROOT);
    if (found !== undefined) return found;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "" || !existsSync(join(dir, "flutter"))) continue;
    try {
      const found = sdk(dirname(dirname(realpathSync(join(dir, "flutter")))));
      if (found !== undefined) return found;
    } catch {
      // A broken link: try the next folder.
    }
  }
  return undefined;
}

/** The Xcode projects and workspaces in the root (no deep scan, N3); a workspace first. */
function xcodeProjects(root: string): string[] {
  try {
    const names = readdirSync(root).filter((n) => /\.(xcodeproj|xcworkspace)$/.test(n));
    return names.sort(
      (a, b) =>
        Number(b.endsWith(".xcworkspace")) - Number(a.endsWith(".xcworkspace")) ||
        a.localeCompare(b),
    );
  } catch {
    return [];
  }
}

/**
 * clang's module cache on macOS, in the per-user cache folder (`C`, the temp folder's sibling), as
 * a real path: Seatbelt compares real paths (/private/var). Without it, SwiftPM's manifest and
 * xcodebuild could not build the Foundation module in the user's iOS check.
 */
export function clangModuleCache(platform: NodeJS.Platform, tempDir: string): string[] {
  if (platform !== "darwin") return [];
  let temp: string;
  try {
    temp = realpathSync(tempDir);
  } catch {
    temp = tempDir;
  }
  if (basename(temp) !== "T") return [];
  return [join(dirname(temp), "C", "clang", "ModuleCache")];
}

/** The Python interpreter for this project: its virtual environment when it has one. */
function pythonRunner(root: string, has: (name: string) => boolean): string {
  if (has(".venv/bin/python")) return ".venv/bin/python";
  if (has("venv/bin/python")) return "venv/bin/python";
  if (has("uv.lock")) return "uv run --offline python";
  if (usesPoetry(root)) return "poetry run python";
  return "python3";
}

function usesPoetry(root: string): boolean {
  try {
    return /^\[tool\.poetry\]/m.test(readFileSync(join(root, "pyproject.toml"), "utf8"));
  } catch {
    return false;
  }
}

function userHome(value: string | undefined, fallback: string): string {
  return value !== undefined && isAbsolute(value) ? value : fallback;
}

/** The access of all profiles together. */
export function profileAccess(profiles: readonly LanguageProfile[]): ProfileAccess {
  const readPaths = [...new Set(profiles.flatMap((p) => p.access.readPaths ?? []))];
  return {
    writePaths: [...new Set(profiles.flatMap((p) => p.access.writePaths))],
    envAllow: [...new Set(profiles.flatMap((p) => p.access.envAllow))],
    ...(readPaths.length === 0 ? {} : { readPaths }),
  };
}

/** The system prompt section for the profiles. Undefined when there are none. */
export function profileNotes(profiles: readonly LanguageProfile[]): string | undefined {
  if (profiles.length === 0) return undefined;
  return profiles.flatMap((p) => p.notes).join("\n");
}
