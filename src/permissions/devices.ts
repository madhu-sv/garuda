import { commandParts } from "./rules.js";

/**
 * T14 part 4 (docs/lld/mobile.md): commands that start or drive a simulator, an emulator or a
 * device. These run outside Garuda's sandbox in effect: the simulator runs as the user (finding 2:
 * `simctl spawn` reads any file), and adb's server controls every attached device. The sandbox
 * blocks both (CoreSimulator's service, and on macOS adb's port since ADB_RULE), so they never run
 * in the sandbox; with `outside_sandbox: true` they ask, and in jobs and evals they are denied.
 *
 * A guard on the command's words, not a shell parser: approval stays the main control.
 */

const SIMULATOR = "the iOS simulator";
const APPLE_DEVICE = "an Apple device";
const ANDROID = "an Android emulator or device";

/** What the command drives, or undefined. Each simple command of `command` counts. */
export function deviceAction(command: string): string | undefined {
  for (const part of commandParts(command)) {
    const found = partAction(part.split(" "));
    if (found !== undefined) return found;
  }
  return undefined;
}

function partAction(words: string[]): string | undefined {
  const program = base(words[0]);
  const args = words.slice(1);
  if (program === "xcrun") {
    if (args.includes("simctl")) return SIMULATOR;
    if (args.includes("devicectl")) return APPLE_DEVICE;
    return undefined;
  }
  if (program === "simctl") return SIMULATOR;
  if (program === "devicectl" || program === "ios-deploy") return APPLE_DEVICE;
  if (program === "open" && /(^|\s)-a\s+'?"?Simulator/.test(args.join(" "))) return SIMULATOR;
  if (program === "adb" || program === "emulator") return ANDROID;
  if (program === "xcodebuild") return xcodebuildAction(args);
  if (program === "gradlew" || program === "gradle") {
    // connectedAndroidTest, connectedCheck, installDebug, uninstallAll: they need a device.
    if (args.some((w) => /^(:?[\w-]+:)*(connected|install|uninstall)[A-Z]/.test(w))) {
      return ANDROID;
    }
  }
  if (program === "flutter" && /^(run|drive|install|attach|screenshot)$/.test(args[0] ?? "")) {
    return "a simulator, emulator or device (flutter)";
  }
  return undefined;
}

/** `xcodebuild test` (or `test-without-building`) with a destination that is not generic. */
function xcodebuildAction(args: string[]): string | undefined {
  if (!args.some((w) => w === "test" || w === "test-without-building")) return undefined;
  const text = args.join(" ");
  const destinations = [...text.matchAll(/-destination\s+(?:'([^']*)'|"([^"]*)"|(\S+))/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? "",
  );
  for (const d of destinations) {
    if (d.startsWith("generic/")) continue;
    if (/Simulator/.test(d)) return SIMULATOR;
    if (/platform=(iOS|tvOS|watchOS|visionOS)\b/.test(d)) return APPLE_DEVICE;
  }
  return undefined;
}

function base(word: string | undefined): string {
  return (
    (word ?? "")
      .replace(/^['"]|['"]$/g, "")
      .split("/")
      .at(-1) ?? ""
  );
}

/**
 * The note when the sandbox refuses a device action: for the model, or for the user when the user
 * typed the command (`!` in the chat, which never runs outside the sandbox).
 */
export function deviceDenial(what: string, strict: boolean, byUser = false): string {
  const why = `This command drives ${what}. That runs outside Garuda's sandbox in effect`;
  if (byUser) {
    return `${why}, so a ! command cannot run it. Run it in your own terminal${strict ? "" : ", or ask the agent: it can run it outside the sandbox after your yes"}.`;
  }
  return strict
    ? `${why}, and the strict profile allows no command outside it. Do not retry it; tell the user what to run.`
    : `${why}, so Garuda does not run it in the sandbox. If it is needed, run it again with outside_sandbox: true; the user must approve. Prefer tests that need no device (unit tests, a build).`;
}

/** The warning under the command when the user is asked about a device action outside the sandbox. */
export function deviceWarning(what: string): string {
  return `This drives ${what}, which runs as you and can read any of your files.`;
}

/** In jobs and evals: no device action, not even outside the sandbox. */
export function deviceUnattendedDenial(what: string): string {
  return `This command drives ${what}. Jobs and evals never run one. Do not retry it; list it in your final answer as work left for the user.`;
}
