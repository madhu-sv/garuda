---
title: "Three ways out of my coding agent's sandbox"
description: "Before I added mobile support to Garuda, I probed its sandbox with the iOS simulator, Gradle and adb. All three let a sandboxed command act with my full rights. What I fixed, what stays open, and the question I now ask first."
date: 2026-11-18
author: Madhusudhan Vasanth Kumar
---

Garuda is an open-source coding agent. Its commands run in an OS sandbox: Seatbelt on macOS,
bubblewrap on Linux. A command can write only in the project, the temp folders and the package
caches, and it cannot read your keys. People asked me whether Garuda can help with mobile apps. So
before I added Android and iOS support, I probed the sandbox with the tools that mobile developers
use every day.

The probes found three ways out. None of them broke a rule of the sandbox. Each one went around
the rules: a service that already ran outside the sandbox did the work for the sandboxed command.

## The pattern

A sandbox limits a process and its children. It does not limit a process that was running before
the command started. If the sandboxed command can talk to such a process, and that process acts on
its request, the work happens with the other process's rights. Security people call this a
confused deputy. Mobile development is full of deputies: simulators, build daemons and device
servers.

Each probe was simple. A control first: in the sandbox, `head -c 4` on a file in my home folder
must fail. Then the same file through the tool under test.

## 1. The iOS simulator

On macOS, a booted simulator runs under CoreSimulatorService, a system service. `xcrun simctl`
talks to that service over Mach messages, and Garuda's Seatbelt profile allowed Mach lookups.

- `xcrun simctl io booted screenshot ~/probe5.png` exited with 0, and the file was in my home
  folder, which the sandbox cannot write. A write escape.
- `xcrun simctl addmedia booted ~/probe6.png` exited with 0 for a file that the control showed as
  blocked. A read escape: the simulator read the file for the command.

The fix in 0.20.1 is one Seatbelt rule:

```scheme
(deny mach-lookup (global-name-regex #"^com\.apple\.CoreSimulator\."))
```

A simulator command now works only outside the sandbox, after you say yes. In 0.21, iOS builds
run in the sandbox, and tests that need the simulator ask.

## 2. Gradle's daemon

This one has nothing to do with mobile. It affects every Gradle project.

Gradle keeps a daemon in the background to make builds fast, and IDEs leave daemons running all
day. A new `./gradlew` client looks for a free daemon in `~/.gradle/daemon` and hands its build to
it. For the probe, I added a task that writes a file in the home folder, and I started a daemon in
a normal terminal. Then a sandboxed `./gradlew probeWrite` succeeded. The file said
"written by pid 59320": the daemon from the normal terminal. The whole build had run outside the
sandbox.

The fix in 0.20.2:

- Sandboxed commands get their own daemon registry, in a temp folder that they can write already
  (`-Dorg.gradle.daemon.registry.base` in `GRADLE_OPTS`).
- Your registry in `~/.gradle/daemon` is hidden from them, for reads and writes. Without it a
  client has no address and no token for your daemons.
- Kotlin's compile daemon is kept out the same way.

With the fix and the outside daemon still running, the sandboxed client started its own daemon,
and the write failed with "Operation not permitted". On Linux each sandboxed command has its own
network, so a daemon outside is out of reach there anyway.

## 3. adb

`adb` talks to an adb server on `localhost:5037`, and that server controls every attached phone and
emulator. With a server started outside the sandbox, a sandboxed `adb devices` listed the devices.

I tried to block the port with Seatbelt. A rule for port 5037 alone worked. With Garuda's other
network rules, which let sandboxed commands reach Garuda's own proxy on localhost, the same rule
blocked all of localhost, and four network tests failed. Seatbelt also refused `127.0.0.1:5037`
("host must be * or localhost"). I found no rule that blocks only that port.

So the fix comes in two parts, and one gap stays open:

- Garuda now looks at what a command drives. `adb`, `emulator`, `xcrun simctl`, `xcrun
  devicectl`, `xcodebuild test` on a simulator or a device, Gradle's `connected…` and `install…`
  tasks, and `flutter run` never run in the sandbox. Outside it, they ask, with a warning that says
  what the command drives. Scheduled jobs and evals never run them. This comes in the next release,
  0.21.
- This check reads the words of the command, so it is not a full fix. On macOS, another program in
  the sandbox, such as a script that opens `localhost:5037`, can still reach a running adb server.
  The guide says so, and says what to do: run `adb kill-server` while Garuda works.

0.20.1 also hid the keys that mobile tools leave in the home folder:
`~/.android/adbkey` (the key your devices trust), App Store Connect API keys, fastlane's session,
Expo's login and Dart's publish credentials.

## What I learned

**Ask what a command talks to, not only what it can touch.** My sandbox rules described files and
network. The escapes came through services: a Mach service, a daemon registry, a local port. Now I
list the background services of a tool before I write a profile for it.

**Probe with a control, and check the probe.** Two of my first probes lied. `test -r` asks only
the permission bits, so it says "readable" for a file that the sandbox blocks; `head -c` opens the
file and tells the truth. And a chat started in the home folder made the whole home folder the
project, so the read rules did not apply.

**Name the limit you cannot close.** The adb gap is in the changelog, the safety guide and the
design note. An honest limit is better than a rule that breaks localhost.

**A fix needs a test that fails without it.** Every fix here has one, and I removed each fix once
to see its test fail. The Seatbelt rules need a Mac, and the CI has no macOS job yet, so each rule
also had a hand test on my machine. A macOS CI job is on the list.

## Try it

0.20.2 is on npm (`@garuda-agent/garuda`) and Homebrew (`madhu-sv/garuda`). The Android and iOS
profiles come in 0.21, with the numbers from a new mobile eval suite. I wrote the fixes with
Claude as a pair programmer.

If you find a way out of the sandbox, please report it privately: see
[SECURITY.md](https://github.com/madhu-sv/garuda/blob/main/SECURITY.md).
