# Mobile apps (T14): design

Status: design, with the user's decisions. Nothing here is built yet. Each claim about what works
needs a measurement before it goes into a guide (T1).

## The problem

People ask whether Garuda can help with mobile apps. Today (0.20.0), from the code, not measured:

| Platform | Today |
| --- | --- |
| React Native and Expo | Works best: TS/JS has the code index, the TypeScript expert and Jest. The Metro or Expo dev server is a long-running process, and background processes are off by default. |
| Android (Kotlin or Java, Gradle) | Partly: the Gradle profile runs `./gradlew test --offline`. Kotlin has no code index or expert. The `maven` network preset does not name Google's Maven host. A debug build needs `~/.android/debug.keystore`, which commands cannot read in "needed" mode or create in either mode. |
| iOS (Swift, Xcode) | Weak: no Swift profile. `xcodebuild` writes `~/Library/Developer/Xcode/DerivedData`, which commands cannot write. SwiftPM starts its own sandbox for manifests, plugins and macros, and a sandbox cannot start inside Seatbelt ("sandbox_apply: Operation not permitted"). |
| Flutter (Dart) | Weak: no Dart profile; `~/.pub-cache` is readable in "needed" mode but not writable. |

## Findings that shape the design

1. **Publishing keys are readable.** The deny list does not have `~/.android/adbkey` (the private
   key that the user's devices trust for adb), `~/.appstoreconnect/private_keys` (App Store Connect
   API keys), `~/.fastlane` (fastlane's Apple session), `~/.expo/state.json` (Expo's login), or
   Dart's publish credentials (`~/Library/Application Support/dart/pub-credentials.json`,
   `~/.config/dart/pub-credentials.json`, and the older `~/.pub-cache/credentials.json`). In
   "needed" mode `~/.pub-cache` is on the readable list, so the old file is readable there too.
2. **The simulator and devices are services outside the sandbox.** The Seatbelt profile allows
   Mach lookups (`allow default`), so `xcrun simctl` reaches CoreSimulatorService. The simulator's
   processes are started by that service, not by the command, so they do not inherit the sandbox:
   `simctl spawn` and an app's test code would run with the user's rights. `adb` reaches an adb
   server on `localhost:5037`, which the profile allows; a server that the user started outside
   the sandbox acts on real devices. Both are hypotheses until the probes below confirm them.
3. **A sandbox in a sandbox fails.** SwiftPM's manifest, plugin and macro sandbox cannot start
   inside Seatbelt. SwiftPM has `--disable-sandbox`; `xcodebuild` has
   `-skipPackagePluginValidation`, `-skipMacroValidation` and the setting
   `IDEPackageSupportDisableManifestSandbox`. Garuda's sandbox then takes the place of SwiftPM's:
   it is stricter on network and writes.
4. **Linux runs only the Android half.** No Xcode; the Android emulator needs `/dev/kvm`, which
   bubblewrap does not give.

## Goals and non-goals

Goals:

- Build and unit-test Android, iOS and Flutter projects in the sandbox, with "needed" reads.
- No publishing key readable by a sandboxed command.
- Simulator, emulator and device actions only with the user's yes, never silently.
- A mobile eval suite, so each claim has numbers.

Non-goals (for now): UI automation, App Store or Play Store upload, signing release builds, device
farms.

## Parts

0. **Security patch (both read modes).** The keys of finding 1 on the deny list. On macOS also
   deny the Mach services of CoreSimulator and the adb port, if the probes confirm finding 2
   (part 4 then lets them through with a yes). A patch release first, as for 0.19.1.
1. **Android profile.** Detected by `com.android.application` or `com.android.library` in a Gradle
   file. Test: `./gradlew testDebugUnitTest --offline`. A `google` network preset
   (`dl.google.com`, `maven.google.com`). Readable: the SDK (`ANDROID_HOME`, already listed) and
   `~/.android/debug.keystore`. If the keystore does not exist, the note says how to make it once
   (`keytool` outside the sandbox); the sandbox never writes `~/.android`.
2. **iOS profile.** Detected by `*.xcodeproj`, `*.xcworkspace` or `Package.swift`. Builds put
   derived data in the project (`-derivedDataPath .build/xcode`, added to the write scope) and pass
   the flags of finding 3. Test: `swift test --disable-sandbox` for a package; `xcodebuild test`
   with a simulator destination only through part 4.
3. **Flutter profile.** Detected by `pubspec.yaml` with a `flutter` key. Test: `flutter test`.
   `~/.pub-cache` writable (its hosted packages), with the credentials file denied. A `pub` network
   preset (`pub.dev`, `storage.googleapis.com`).
4. **Simulator, emulator and device actions.** Commands that start or drive them (`xcrun simctl`,
   `xcodebuild test -destination 'platform=iOS Simulator…'`, `adb`, `emulator`,
   `flutter run`) run only with `outside_sandbox` and the user's yes, with a note that says why. In
   jobs and evals they are denied.
5. **Code intelligence.** Kotlin and Swift: approximate labels only (as T10 asks), or none. A
   separate decision after the profiles.
6. **Eval suite `mobile`.** Small Android, iOS and Flutter projects with hidden tests and traps,
   run in both read modes. iOS tasks run only on macOS; tasks skip with a reason where the
   toolchain is missing.
7. **Guide page "Mobile apps"**: what works, what asks, what is out of scope, with the numbers.

## Probes (on the user's Mac, before part 0)

Each probe runs a command in Garuda's sandbox (`!` in chat) with a test file in a denied folder.
No real key is read.

1. `xcrun simctl list devices`: does the sandbox reach CoreSimulatorService?
2. With a booted simulator: `xcrun simctl spawn booted /bin/cat <test file>`: does a denied file
   come back? If yes, finding 2 holds for reads.
3. `swift build` in a small package with a dependency: the nested-sandbox error, then
   `--disable-sandbox`.
4. With an adb server started outside the sandbox: `adb devices`: does the sandbox reach it?

## Measurement

The mobile suite in both read modes, Haiku 5.5, `--repeat 3`, as T15. Acceptance: the claims in
the guide page match the numbers; no publishing key readable; no simulator, emulator or device
action without a yes.

## Decisions (the user, 2026-11-10)

1. **Part 0 ships first, as 0.20.1**, after the probes: a security fix in both read modes.
2. **Simulator, emulator and devices: denied in the sandbox.** They run only through
   `outside_sandbox` with the user's yes, and never in jobs or evals. iOS app tests that need a
   simulator always ask.
3. **0.21 holds the Android and iOS profiles** (parts 1, 2, 4, 6 and 7). Flutter (part 3) comes in
   a later release.
4. **Code intelligence for Kotlin and Swift later** (part 5), decided from the eval numbers.

## Plan

1. The probes on the Mac.
2. Part 0 and, if probe 1 or 4 confirms it, the denied simulator services and adb port: 0.20.1.
3. The Android profile, the iOS profile and part 4; then the `mobile` eval suite and its
   measurement; then the guide page: 0.21.
