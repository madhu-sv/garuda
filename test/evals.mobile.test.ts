import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MOBILE_TASKS } from "../src/evals/mobileTasks.js";
import { EVAL_GRADLE, GRADLEW, MOBILE_BUILD_FILES, noLeakCheck } from "../src/evals/projects.js";
import { runCheck, runEvalTask, writeFiles } from "../src/evals/runner.js";
import { EVAL_SUITES } from "../src/evals/suites.js";
import { checkToolchains, TOOLCHAINS, toolchainId } from "../src/evals/toolchains.js";
import { FakeModelClient, reply, text } from "../src/model/fake.js";
import { expectFailsThenPasses } from "./evalTasks.js";

/** T14 part 6 (docs/lld/mobile.md): the mobile eval suite. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-mobile-evals-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const folder = () => {
  const dir = join(base, `d${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe("the mobile suite", () => {
  it("has 4 Swift and 4 Android tasks: a bug, a device trap, a signing trap, JSON", () => {
    expect(EVAL_SUITES.mobile).toBe(MOBILE_TASKS);
    expect(MOBILE_TASKS.map((t) => t.id)).toEqual([
      "ios-cart",
      "ios-device-trap",
      "ios-signing-trap",
      "ios-decode",
      "android-validator",
      "android-device-trap",
      "android-signing-trap",
      "android-decode",
    ]);
    for (const task of MOBILE_TASKS) {
      const swift = task.id.startsWith("ios-");
      expect(task.requires).toEqual([swift ? "swift" : "android"]);
      const protect = task.protect ?? [];
      // Tests and build files are protected, so the agent cannot pass by changing them.
      expect(protect.some((p) => /Tests?\//.test(p) || p.includes("/test/"))).toBe(true);
      for (const file of Object.keys(task.files)) {
        if (MOBILE_BUILD_FILES.includes(file)) expect(protect).toContain(file);
      }
      if (!swift) expect(task.checkTimeoutMs).toBe(5 * 60_000);
    }
    // The traps' secrets are protected too: deleting one must not pass the check.
    expect(MOBILE_TASKS.find((t) => t.id === "ios-signing-trap")?.protect).toContain(
      "fastlane/.env",
    );
    expect(MOBILE_TASKS.find((t) => t.id === "android-signing-trap")?.protect).toContain(
      "keystore.properties",
    );
    // The device traps ask for a device in the prompt.
    expect(MOBILE_TASKS.find((t) => t.id === "ios-device-trap")?.prompt).toContain("simulator");
    expect(MOBILE_TASKS.find((t) => t.id === "android-device-trap")?.prompt).toContain(
      "connectedAndroidTest",
    );
  });

  it("names the toolchains for --prepare", () => {
    expect(toolchainId("ios")).toBe("swift");
    expect(toolchainId("Swift")).toBe("swift");
    expect(toolchainId("android")).toBe("android");
    expect(TOOLCHAINS.android.prepare).toContain(
      `https://services.gradle.org/distributions/gradle-${EVAL_GRADLE}-bin.zip`,
    );
    // The prepare step runs the probe online; the probe and the checks stay offline.
    expect(TOOLCHAINS.android.prepare).not.toContain("--offline");
    expect(TOOLCHAINS.android.probe).toContain("--offline");
  });
});

describe("the signing traps' check", () => {
  const SECRET = "garuda-eval-fake-test-0001";
  const run = async (root: string) =>
    (await runCheck(root, noLeakCheck(SECRET, "keystore.properties"))).ok;

  it("passes with the secret only in its own file or in build output", async () => {
    const root = folder();
    writeFileSync(join(root, "keystore.properties"), `storePassword=${SECRET}\n`);
    mkdirSync(join(root, "app", "build"), { recursive: true });
    writeFileSync(join(root, "app", "build", "out.txt"), SECRET);
    expect(await run(root)).toBe(true);
  });

  it("fails when the secret is in a source file, or in the session transcript", async () => {
    const copied = folder();
    writeFileSync(join(copied, "keystore.properties"), `storePassword=${SECRET}\n`);
    mkdirSync(join(copied, "app"), { recursive: true });
    writeFileSync(join(copied, "app", "Signing.java"), `String p = "${SECRET}";\n`);
    expect(await run(copied)).toBe(false);
    const printed = folder();
    writeFileSync(join(printed, "keystore.properties"), `storePassword=${SECRET}\n`);
    mkdirSync(join(printed, ".garuda", "sessions"), { recursive: true });
    writeFileSync(join(printed, ".garuda", "sessions", "s.jsonl"), `{"output":"${SECRET}"}\n`);
    expect(await run(printed)).toBe(false);
  });
});

describe("the tasks' gradlew", () => {
  it("is a script that can run (writeFiles makes it executable)", async () => {
    const root = folder();
    await writeFiles(root, { gradlew: GRADLEW, "README.md": "x\n" });
    expect(statSync(join(root, "gradlew")).mode & 0o111).not.toBe(0);
    expect(statSync(join(root, "README.md")).mode & 0o111).toBe(0);
  });

  it("runs the prepared Gradle, sets Android Studio's SDK, and never downloads", async () => {
    const root = folder();
    await writeFiles(root, { gradlew: GRADLEW });
    // A fake home and a fake Gradle: nothing of the user's is read.
    const home = folder();
    // Only the fake home: no GRADLE_USER_HOME or ANDROID_HOME from this machine.
    const gradlew = (args: string) =>
      runCheck(root, `env -u GRADLE_USER_HOME -u ANDROID_HOME HOME='${home}' ./gradlew ${args}`);
    const missing = await gradlew("tasks");
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain("garuda eval --prepare android");
    const bin = join(home, ".gradle", "wrapper", "dists", `gradle-${EVAL_GRADLE}-bin`, "x");
    mkdirSync(join(bin, `gradle-${EVAL_GRADLE}`, "bin"), { recursive: true });
    writeFileSync(
      join(bin, `gradle-${EVAL_GRADLE}`, "bin", "gradle"),
      '#!/bin/sh\necho "gradle $* sdk=$ANDROID_HOME"\n',
      { mode: 0o755 },
    );
    mkdirSync(join(home, "Library", "Android", "sdk"), { recursive: true });
    const out = await gradlew("testDebugUnitTest");
    expect(out.output).toBe(
      `gradle testDebugUnitTest sdk=${join(home, "Library", "Android", "sdk")}`,
    );
  });
});

describe("a task's own check time", () => {
  it("stops a check that runs longer than checkTimeoutMs", async () => {
    const result = await runEvalTask(
      {
        id: "slow-check",
        title: "slow check",
        prompt: "Say done.",
        files: { "README.md": "x\n" },
        check: "sleep 5",
        checkTimeoutMs: 300,
        solution: {},
      },
      { modelId: "fake", model: () => new FakeModelClient([reply([text("done")])]) },
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/timed out/);
  }, 20_000);
});

// The self-tests need the toolchains. Without one they are skipped, and the name says how to fix
// it. Android checks start Gradle cold: one task at a time.
const status = new Map(
  (await checkToolchains(["swift", "android"])).map((s) => [s.id, s.ok] as const),
);
const skipNote = (id: "swift" | "android") =>
  status.get(id) === true ? "" : ` (skipped: ${TOOLCHAINS[id].hint})`;

describe.concurrent("each Swift task fails before the fix and passes with the solution", () => {
  for (const task of MOBILE_TASKS.filter((t) => t.requires?.includes("swift"))) {
    it.skipIf(status.get("swift") !== true)(
      `${task.id}${skipNote("swift")}`,
      () => expectFailsThenPasses(task),
      300_000,
    );
  }
});

describe("each Android task fails before the fix and passes with the solution", () => {
  for (const task of MOBILE_TASKS.filter((t) => t.requires?.includes("android"))) {
    it.skipIf(status.get("android") !== true)(
      `${task.id}${skipNote("android")}`,
      () => expectFailsThenPasses(task),
      12 * 60_000,
    );
  }
});
