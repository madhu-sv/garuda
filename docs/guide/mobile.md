# Mobile apps

Android, iOS and Flutter projects in Garuda's sandbox: what works, what asks, and what is out of
scope. Every claim here comes from the `mobile` eval suite or from a probe on a Mac (Xcode 27, iOS
27.2, Android SDK 35, Flutter 3.50.1). React Native has no profile of its own yet.

## What works in the sandbox

| Project | Garuda finds it by | Tests | Build |
| --- | --- | --- | --- |
| Android (Gradle, Kotlin or Java) | the Android plugin in a Gradle file | `./gradlew testDebugUnitTest --offline` | `./gradlew compileDebugSources --offline` (no signing) |
| Swift package | `Package.swift` | `swift test --disable-sandbox` | `swift build --disable-sandbox` |
| Xcode project or workspace | `*.xcodeproj`, `*.xcworkspace` | only outside the sandbox (below) | `xcodebuild build … -destination 'generic/platform=iOS Simulator'` |
| Flutter | `pubspec.yaml` with a `flutter` section or dependency | `flutter test` | — (`flutter analyze` checks the code) |

The chat's start shows the profile ("This looks like Swift (SwiftPM)"), and the agent gets its
commands. For details per profile, see [Projects](projects.md).

- **Android.** Gradle's caches in `~/.gradle` are writable, and the debug keystore is readable;
  `~/.android` is never writable. Sandboxed Gradle starts its own daemons: never one that you or
  your IDE started (0.20.2). For the first download of the Android plugin, add the `google` and
  `maven` presets to `network.allow`, or run the build once outside Garuda.
- **Swift.** `--disable-sandbox` turns off SwiftPM's own sandbox, which cannot start inside
  Garuda's; Garuda's sandbox takes its place, and it is stricter on network and writes. clang's
  module cache in macOS's per-user cache folder is writable. SwiftPM warns that
  `~/Library/org.swift.swiftpm` is not writable: that folder holds the fingerprints of trusted
  packages, so Garuda keeps it read-only.
- **Xcode.** The build writes derived data in `.build/xcode` in the project (add it to
  `.gitignore`), with code signing and Xcode's own manifest sandbox off. The scheme is a guess from
  the project's name: check it with `xcodebuild -list`.
- **Flutter.** `flutter test` runs in Flutter's headless engine on your computer, so it needs no
  device. The pub cache's package folders are writable; its executables and `credentials.json` are
  not. In the Flutter SDK the sandbox writes only two small files that every `flutter` command
  writes (its lock file and `engine.realm`), never the Flutter tool or the Dart SDK, which run
  outside the sandbox later. So each command prints one harmless error about `engine.stamp`, which
  Garuda does not count as a sandbox block. Checked on a Mac: `flutter test` passes in the sandbox.
  Flutter's settings (`~/.config/flutter`) are readable, not writable. Of the telemetry, only the
  session and log files are writable; your telemetry choice is not. After
  `flutter upgrade`, run one `flutter` command outside Garuda first: it rebuilds the tool in the
  SDK. For new packages, add the `pub` preset to `network.allow`, or run `flutter pub get` once
  outside Garuda.

## What asks first

A simulator, an emulator or a device runs as you: a booted iOS simulator can read any of your
files, and an adb server controls every attached device. The sandbox cannot reach either (after
0.21.1 also not adb's port on macOS, nor any daemon over a Unix socket), so these commands would fail in it. Garuda never runs them
in the sandbox:

- `xcrun simctl`, `xcrun devicectl`, `open -a Simulator`;
- `xcodebuild test` on a simulator or a device (so iOS app tests);
- `adb`, `emulator`, Gradle's `connected…` and `install…` tasks (so instrumented tests);
- `flutter run`, `drive`, `install`, `attach`, `screenshot`.

The agent can run one outside the sandbox. Then Garuda asks you, and a line under the command says
what it drives:

```text
bash wants to run a command (OUTSIDE the sandbox: network on, writes anywhere):
  $ xcrun simctl list devices available
  ! This drives the iOS simulator, which runs as you and can read any of your files.
```

Scheduled jobs and evals never run these commands, also with an allow rule. A `!` command that you
type in the chat runs only in the sandbox, so run these in your own terminal or ask the agent.

## Keys

Sandboxed commands cannot read the keys that publish your apps or that your devices trust, in
both read modes (0.20.1): `~/.android/adbkey`, `~/.emulator_console_auth_token`, App Store Connect
API keys (`~/.appstoreconnect`), fastlane's session (`~/.fastlane`), Expo's login and Dart's
publish credentials.

## The numbers

The `mobile` eval suite has 8 tasks: 4 Swift packages and 4 Android modules (a bug, a device trap,
a signing-key trap, JSON with renamed keys). With Haiku 5.5, 3 runs of each task, in the Seatbelt
sandbox on a Mac:

| Reads | Passed | Cost of the 24 runs | Mean steps per task |
| --- | --- | --- | --- |
| `needed` (the default) | 24 of 24 | $0.036 | 4.0 to 6.3 |
| `open` | 24 of 24 | $0.035 | 4.0 to 6.3 |

- **Device traps.** The prompt asks to confirm on the simulator or the emulator. In all 6 Android
  runs the agent tried `./gradlew connectedAndroidTest`; Garuda denied it, and the agent fixed the
  code with the unit tests and said that the emulator run is left for you. The Swift task has no
  app, and the agent said so and did not try the simulator.
- **Signing-key traps.** A fake password sits in `fastlane/.env` or `keystore.properties`. In no
  run did it reach another file or Garuda's transcript.

These numbers are for the first 8 tasks. A ninth task, `xcode-device-trap`, came later: the cart
bug on an iOS package, graded through `xcodebuild` (the unit tests on the host, then an iOS build
for the simulator SDK, which boots no simulator). It is not measured yet.

To run the suite yourself, see [Evals](evals.md) (`garuda eval --prepare android` once, and
`garuda eval --prepare xcode` to check Xcode).

## Known limits

- The device check reads the command's words. A command that hides the program (a script, or
  `$(which adb)`) is not found by it; the sandbox's own rules still apply to it.
- The suite's Swift tasks are packages, not apps. `xcode-device-trap` builds its package with
  `xcodebuild` for the iOS simulator, but no task builds an Xcode app project yet. The Xcode
  profile's build of an app was checked by hand on a Mac.
- Not in scope: UI automation, App Store or Play Store upload, signed release builds, device farms.
- Flutter: Garuda finds the SDK from `FLUTTER_ROOT` or the `flutter` on your `PATH`; FVM's
  per-project SDKs are not supported yet. A plain Dart package has no profile, and the `mobile` suite
  has no Flutter tasks yet.
- React Native: no profile yet. React Native's TypeScript side works as any Node
  project; Metro and Expo's dev server are long-running processes, which need background
  processes (off by default).
- Kotlin and Swift have no code index or language expert yet.
