import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { questionContent } from "../src/acp/approver.js";
import { Runtime } from "../src/app/runtime.js";
import { colorPreview } from "../src/cli/approver.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { runEvalTask } from "../src/evals/runner.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { deviceAction } from "../src/permissions/devices.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { parseSettings } from "../src/permissions/settings.js";
import type {
  ApprovalChoice,
  ApprovalRequest,
  Approver,
  CallTarget,
  PermissionRequest,
} from "../src/permissions/types.js";
import { USER_CALL_PREFIX } from "../src/permissions/types.js";
import { findOsSandbox } from "../src/sandbox/index.js";
import { FileSessionStore } from "../src/session/store.js";

/** T14 part 4 (docs/lld/mobile.md): simulators, emulators and devices never run in the sandbox. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-devices-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("deviceAction", () => {
  it("finds the iOS simulator, Apple devices, adb, the emulator and Flutter's device commands", () => {
    const sim = "the iOS simulator";
    const android = "an Android emulator or device";
    expect(deviceAction("xcrun simctl list devices available")).toBe(sim);
    expect(deviceAction("xcrun --sdk iphonesimulator simctl boot X")).toBe(sim);
    expect(deviceAction("open -a Simulator")).toBe(sim);
    expect(deviceAction("xcrun devicectl list devices")).toBe("an Apple device");
    // The xcode profile's own test command.
    expect(
      deviceAction(
        "xcodebuild test -project Shop.xcodeproj -scheme Shop -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath .build/xcode",
      ),
    ).toBe(sim);
    expect(deviceAction("xcodebuild test -scheme Shop -destination 'platform=iOS,id=0001'")).toBe(
      "an Apple device",
    );
    expect(deviceAction("adb devices")).toBe(android);
    expect(deviceAction("ANDROID_SERIAL=x adb shell ls")).toBe(android);
    expect(deviceAction("npm test && adb install app.apk")).toBe(android);
    expect(deviceAction("~/Library/Android/sdk/emulator/emulator -avd Pixel")).toBe(android);
    expect(deviceAction("./gradlew connectedAndroidTest --offline")).toBe(android);
    expect(deviceAction("./gradlew :app:installDebug")).toBe(android);
    expect(deviceAction("flutter run -d emulator-5554")).toContain("flutter");
  });

  it("leaves builds, unit tests and words that only name a tool", () => {
    for (const command of [
      "swift test --disable-sandbox",
      "xcodebuild build -scheme Shop -destination 'generic/platform=iOS Simulator'",
      "xcodebuild test -scheme Shop -destination 'generic/platform=iOS Simulator'",
      "xcodebuild test -scheme Mac -destination 'platform=macOS'",
      "xcodebuild -list -project Shop.xcodeproj",
      "./gradlew testDebugUnitTest --offline",
      "./gradlew compileDebugSources --offline",
      // The Maven plugin's install task needs no device.
      "./gradlew install",
      "flutter test",
      "grep -rn adb src",
      "cat emulator.md",
      "open -a Safari",
    ]) {
      expect(deviceAction(command), command).toBeUndefined();
    }
  });
});

const cmd = (command: string, outsideSandbox = false): CallTarget => ({
  kind: "command",
  command,
  ...(outsideSandbox ? { outsideSandbox: true } : {}),
});
const request = (target: CallTarget): PermissionRequest => ({
  tool: "bash",
  readOnly: false,
  info: { target },
});
const signal = new AbortController().signal;

class Recorder implements Approver {
  asked: ApprovalRequest[] = [];
  async ask(req: ApprovalRequest): Promise<ApprovalChoice> {
    this.asked.push(req);
    return "once";
  }
}

describe("the permission engine", () => {
  const engine = (approver: Approver, extra: Record<string, unknown> = {}) =>
    new PermissionEngine({ root: base, approver, isolation: "os", ...extra });

  it("in the sandbox: denied, with outside_sandbox as the way; nobody is asked", async () => {
    const approver = new Recorder();
    const decision = await engine(approver).check(request(cmd("adb devices")), signal);
    expect(decision).toMatchObject({ allowed: false });
    if (!decision.allowed) {
      expect(decision.reason).toContain("drives an Android emulator or device");
      expect(decision.reason).toContain("outside_sandbox: true; the user must approve");
    }
    expect(approver.asked).toEqual([]);
    // Plan mode lets sandboxed commands run, but not this one.
    const plan = await engine(approver, { mode: () => "plan" }).check(
      request(cmd("xcrun simctl list")),
      signal,
    );
    expect(plan.allowed).toBe(false);
    // Other commands still run in the sandbox.
    expect((await engine(approver).check(request(cmd("swift test")), signal)).allowed).toBe(true);
  });

  it("outside the sandbox: the user is asked, with a warning that says why", async () => {
    const approver = new Recorder();
    const decision = await engine(approver).check(request(cmd("adb devices", true)), signal);
    expect(decision.allowed).toBe(true);
    expect(approver.asked).toHaveLength(1);
    expect(approver.asked[0]?.warning).toBe(
      "This drives an Android emulator or device, which runs as you and can read any of your files.",
    );
    // Any other command outside the sandbox has no warning.
    await engine(approver).check(request(cmd("npm install", true)), signal);
    expect(approver.asked[1]?.warning).toBeUndefined();
  });

  it("a ! command that the user typed gets a note for the user, not for the model", async () => {
    const decision = await engine(new Recorder()).check(
      { ...request(cmd("xcrun simctl list devices")), callId: `${USER_CALL_PREFIX}1` },
      signal,
    );
    if (decision.allowed) throw new Error("allowed");
    expect(decision.reason).toBe(
      "This command drives the iOS simulator. That runs outside Garuda's sandbox in effect, so a ! command cannot run it. Run it in your own terminal, or ask the agent: it can run it outside the sandbox after your yes.",
    );
  });

  it("the strict profile names no way out", async () => {
    const decision = await engine(new Recorder(), { policy: { requireSandbox: true } }).check(
      request(cmd("adb devices")),
      signal,
    );
    if (decision.allowed) throw new Error("allowed");
    expect(decision.reason).toContain("strict profile");
    expect(decision.reason).not.toContain("outside_sandbox: true");
  });

  it("jobs and evals: denied also outside the sandbox, also with an allow rule", async () => {
    const settings = parseSettings({ permissions: { allow: ["bash(adb*)"] } });
    const denied: string[] = [];
    const job = engine(new AutoApprover("once"), {
      settings,
      unattended: { reason: "job", onDeny: (tool: string) => denied.push(tool) },
    });
    const decision = await job.check(request(cmd("adb devices", true)), signal);
    if (decision.allowed) throw new Error("allowed");
    expect(decision.reason).toContain("Jobs and evals never run one");
    expect(denied).toEqual(["bash"]);
    const evals = engine(new AutoApprover("once"), { settings, deviceQuestions: false });
    expect((await evals.check(request(cmd("adb devices", true)), signal)).allowed).toBe(false);
    // Without the option, the allow rule is the user's yes in advance.
    const user = engine(new AutoApprover("once"), { settings });
    expect((await user.check(request(cmd("adb devices", true)), signal)).allowed).toBe(true);
  });
});

describe("an eval", () => {
  it("never runs a device command, though its approver says yes to everything", async () => {
    // `true ||` keeps adb from running if the denial fails; the file shows that the command ran.
    const command = "true || adb devices; echo ran > ran.txt";
    const result = await runEvalTask(
      {
        id: "device-probe",
        title: "device probe",
        prompt: "Run it.",
        files: { "README.md": "x\n" },
        check: "test ! -e ran.txt",
        solution: {},
      },
      {
        modelId: "fake",
        model: () =>
          new FakeModelClient([
            reply([toolUse("bash", { command, outside_sandbox: true }, "b1")]),
            reply([text("done")]),
          ]),
      },
    );
    expect(result.passed, result.reason).toBe(true);
    expect(existsSync(join(process.cwd(), "ran.txt"))).toBe(false);
  });
});

describe("the warning on screen", () => {
  const asked: ApprovalRequest = {
    tool: "bash",
    target: { kind: "command", command: "adb devices", outsideSandbox: true },
    preview: "adb devices",
    isolation: "os",
    warning:
      "This drives an Android emulator or device, which runs as you and can read any of your files.",
  };

  it("the chat keeps it in the scrollback after the answer; the terminal and editors show it", async () => {
    const store = new ChatStore({ model: "m", sandbox: "s" }, { paint: noColor });
    const answer = store.ask(asked, signal);
    store.choose("once");
    expect(await answer).toBe("once");
    const scrollback = store
      .getState()
      .items.map((i) => ("text" in i ? i.text : ""))
      .join("\n");
    expect(scrollback).toContain("! This drives an Android emulator or device");
    expect(stripVTControlCharacters(colorPreview(asked))).toContain(
      "! This drives an Android emulator",
    );
    expect(JSON.stringify(questionContent(asked))).toContain("! This drives an Android emulator");
  });
});

// The runtime marks the user's ! commands, so the engine can tell them apart.
const found = findOsSandbox();
describe.runIf("executor" in found)("a ! command in the chat", () => {
  it("is denied with the user's note", async () => {
    const root = join(base, "chat");
    mkdirSync(root, { recursive: true });
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: async () => new FakeModelClient([]),
      approver: new Recorder(),
      store: new FileSessionStore(root),
      settings: parseSettings({}),
      mcp: false,
      hooks: false,
      commands: false,
      profiles: [],
    });
    try {
      const result = await runtime.runUserCommand("adb devices", signal);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("so a ! command cannot run it");
    } finally {
      await runtime.close();
    }
  });
});
