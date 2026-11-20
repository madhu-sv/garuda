import type { AgentEvent } from "../loop/events.js";
import type { CommandFacts } from "../tools/types.js";

/**
 * The receipt of a turn (UX U1; docs/lld/ux.md): what changed, which tests ran, where the commands
 * ran, and what the turn cost. Pure: the runtime collects the facts, the views draw them.
 */
export interface Receipt {
  /** 1, 2, 3 … in the session. */
  turn: number;
  stopReason: string;
  steps: number;
  durationMs: number;
  /** The turn's cost; undefined when unknown. */
  costUsd?: number;
  costIncomplete?: boolean;
  /** The changed files with their lines; undefined when undo is off (no snapshots). */
  files?: ReceiptFile[];
  /** The last test run of the turn; absent when no test ran. */
  tests?: ReceiptTests;
  commands: { sandboxed: number; outside: number; blockedHosts: string[] };
  contextPercent: number;
  sessionCostUsd?: number;
  sessionCostIncomplete?: boolean;
  /** Turns of the session that changed files and were not undone; absent when undo is off. */
  keptChanges?: number;
}

export interface ReceiptFile {
  path: string;
  /** Absent for a binary file. */
  added?: number;
  removed?: number;
}

export interface ReceiptTests {
  /** The command as the model ran it, cut to one short line. */
  command: string;
  /**
   * True only when the command succeeded and its output counted at least one test (review,
   * 2026-11: a receipt said "Tests passed" when no test ran).
   */
  passed: boolean;
  /**
   * Why a successful command did not pass: "none", no test ran (a count of 0, or the runner said
   * so); "uncounted", the output had no test count, so Garuda cannot say that tests ran. Absent
   * when tests passed or failed, and in records before this field.
   */
  ran?: "none" | "uncounted";
  /** For "none": the runner's words, for example "Gradle: up to date". */
  reason?: string;
  timedOut?: boolean;
  total?: number;
  failed?: number;
  /** The total of the last earlier test run with a count, for "was 121". */
  previousTotal?: number;
}

/**
 * A receipt only when it has news (decision D1, narrowed after the first live run): files
 * changed, tests ran, a command ran outside the sandbox, or the proxy blocked a host. A turn that
 * only read, also with a command in the sandbox (`find`, `ls`), keeps the usage line.
 */
export function hasReceipt(receipt: Receipt): boolean {
  return (
    (receipt.files?.length ?? 0) > 0 ||
    receipt.tests !== undefined ||
    receipt.commands.outside > 0 ||
    receipt.commands.blockedHosts.length > 0
  );
}

const RUNNERS =
  /(^|[\s;&|(/])(vitest|jest|pytest|py\.test|mvn|mvnw|gradle|gradlew|go\s+test|node\s+--test|(npm|pnpm|yarn|bun)\s+(run\s+)?test|cargo\s+test|swift\s+test|flutter\s+test|dart\s+test|xcodebuild\b[^;&|]*\stest(-without-building)?|tox|nox)\b/;

/** A command that runs tests: the project's test command, or a known runner (decision D2). */
export function isTestCommand(command: string, projectTest: string | undefined): boolean {
  const text = command.trim();
  if (projectTest !== undefined && projectTest !== "" && text.includes(projectTest)) return true;
  if (
    /(^|[\s;&|])(mvn|mvnw|gradle|gradlew)\b/.test(text) &&
    !/\b(test|verify|check)\b/.test(text)
  ) {
    return false;
  }
  return RUNNERS.test(text);
}

/**
 * The test count from a runner's summary line: vitest, jest, node:test, pytest, Maven Surefire and
 * `go test -v` (decision D2). Undefined for an unknown runner, or when the output lost the line.
 */
export function parseTestCount(output: string): { total: number; failed: number } | undefined {
  const num = (s: string | undefined) => (s === undefined ? 0 : Number(s));
  // The count is tests that ran: passed + failed, never skipped or todo. A run with only skipped
  // tests ran nothing, so the receipt says "no tests ran", not "passed" (2026-11 review, P1: a
  // skipped node:test showed "✓ passed").
  // vitest: "Tests  2 failed | 122 passed | 55 skipped (1245)". The grand total in () counts
  // skipped, so add up passed and failed instead. "expected fail" is not "failed".
  const vitest = /^\s*Tests\s+(.*\b(?:passed|failed|skipped)\b.*?)\s+\(\d+\)\s*$/m.exec(output);
  if (vitest !== null) {
    const seg = vitest[1] ?? "";
    const failed = num(/(\d+) failed/.exec(seg)?.[1]);
    return { total: num(/(\d+) passed/.exec(seg)?.[1]) + failed, failed };
  }
  // jest: "Tests:       1 skipped, 2 failed, 122 passed, 124 total" (total counts skipped too).
  const jest = /^Tests:\s+(.*?) total\s*$/m.exec(output);
  if (jest !== null) {
    const seg = jest[1] ?? "";
    const failed = num(/(\d+) failed/.exec(seg)?.[1]);
    return { total: num(/(\d+) passed/.exec(seg)?.[1]) + failed, failed };
  }
  // node:test (tap or spec): "# tests 124" / "ℹ tests 124", "# pass", "# fail". "tests" counts
  // skipped and todo, so the count that ran is pass + fail.
  const nodeTotal = /^(?:#|ℹ) tests (\d+)\s*$/m.exec(output);
  if (nodeTotal !== null) {
    const pass = /^(?:#|ℹ) pass (\d+)\s*$/m.exec(output);
    const fail = /^(?:#|ℹ) fail (\d+)\s*$/m.exec(output);
    const failed = num(fail?.[1]);
    // Older node without the pass/fail lines: fall back to "tests".
    const ran = pass !== null || fail !== null ? num(pass?.[1]) + failed : num(nodeTotal[1]);
    return { total: ran, failed };
  }
  // pytest: "==== 2 failed, 122 passed in 1.23s ====" (also errors)
  const pytest = /^=+ (.*\b(?:passed|failed)\b.*) in [\d.]+s(?: \([^)]*\))? =+\s*$/m.exec(output);
  if (pytest !== null) {
    const part = (word: string) => num(new RegExp(`(\\d+) ${word}\\b`).exec(pytest[1] ?? "")?.[1]);
    const failed = part("failed") + part("errors?");
    return { total: part("passed") + failed, failed };
  }
  // Maven Surefire: the last "Tests run: 124, Failures: 1, Errors: 0, Skipped: 0" is the total.
  const maven = [...output.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+)/g)].at(-1);
  if (maven !== undefined) {
    return { total: num(maven[1]), failed: num(maven[2]) + num(maven[3]) };
  }
  // XCTest (swift test, xcodebuild test): the last "Executed 5 tests, with 1 failure" is the total.
  // Swift Testing adds its own line: "✔ Test run with 3 tests in 1 suite passed", or "✘ … failed
  // … with 2 issues" (T14). Both run in one `swift test`.
  const xctest = [...output.matchAll(/Executed (\d+) tests?, with (\d+) failures?/g)].at(-1);
  const swiftTesting =
    /Test run with (\d+) tests?\b.*?(passed|failed)(?:.*?with (\d+) issues?)?/.exec(output);
  if (xctest !== undefined || swiftTesting !== null) {
    const total = num(xctest?.[1]) + num(swiftTesting?.[1]);
    const failed =
      num(xctest?.[2]) + (swiftTesting?.[2] === "failed" ? Math.max(1, num(swiftTesting[3])) : 0);
    return { total, failed };
  }
  // package:test (flutter test, dart test): "00:02 +3 ~1 -1: Some tests failed." The last counter
  // line has the totals: + passed, ~ skipped, - failed (T14 part 3).
  const dartTest = [...output.matchAll(/^\s*\d+:\d\d \+(\d+)(?: ~\d+)?(?: -(\d+))?:/gm)].at(-1);
  if (dartTest !== undefined) {
    const failed = num(dartTest[2]);
    return { total: num(dartTest[1]) + failed, failed };
  }
  // go test -v: one line per test.
  const passes = output.match(/^\s*--- PASS: /gm)?.length ?? 0;
  const fails = output.match(/^\s*--- FAIL: /gm)?.length ?? 0;
  if (passes + fails > 0) return { total: passes + fails, failed: fails };
  return undefined;
}

/**
 * A runner's own words for "no test ran" in a successful run (or pytest's exit code 5). Gradle's
 * test tasks count only when every test task in the output was skipped that way.
 */
export function noTestsReason(output: string, exitCode: number | null): string | undefined {
  if (exitCode === 5 && /\bno tests ran\b/.test(output)) return "pytest: no tests collected";
  if (exitCode !== 0) return undefined;
  if (/\bNo test files found\b/.test(output)) return "no test files found";
  if (/\bNo tests found\b/.test(output)) return "no tests found";
  if (/\bNo tests to run\b/.test(output)) return "Maven: no tests to run";
  if (/\[no test files\]/.test(output) && !/^ok\s/m.test(output)) return "go: no test files";
  const tasks = [
    ...output.matchAll(
      /^> Task :\S*[Tt]est\S*(?:\s+(UP-TO-DATE|NO-SOURCE|FROM-CACHE|SKIPPED))?\s*$/gm,
    ),
  ];
  if (tasks.length > 0 && tasks.every((t) => t[1] !== undefined)) {
    const kinds = new Set(tasks.map((t) => t[1]));
    if (kinds.has("NO-SOURCE") && kinds.size === 1) return "Gradle: no test sources";
    if (kinds.has("FROM-CACHE") && kinds.size === 1) return "Gradle: results from the build cache";
    return "Gradle: up to date";
  }
  return undefined;
}

/** The facts of one turn's commands, from the loop's events. */
export class ReceiptCollector {
  private readonly calls = new Map<string, string>();
  sandboxed = 0;
  outside = 0;
  readonly blockedHosts = new Set<string>();
  tests: ReceiptTests | undefined;

  constructor(private readonly projectTest: string | undefined) {}

  onEvent(event: AgentEvent): void {
    if (event.type === "tool_call") {
      const command = (event.call.input as { command?: unknown }).command;
      if (typeof command === "string") this.calls.set(event.call.id, command);
      return;
    }
    if (event.type !== "tool_result" || event.outcome.command === undefined) return;
    this.add(this.calls.get(event.call.id) ?? "", event.outcome.command, event.outcome.content);
  }

  /** One command's facts; `output` is the text that the model got (for the test count). */
  add(command: string, facts: CommandFacts, output: string): void {
    if (facts.sandboxed) this.sandboxed++;
    else this.outside++;
    for (const host of facts.blockedHosts) this.blockedHosts.add(host);
    if (!isTestCommand(command, this.projectTest)) return;
    const count = parseTestCount(output);
    const counts = count === undefined ? {} : { total: count.total, failed: count.failed };
    const base = { command: shortCommand(command), ...counts };
    const none = facts.timedOut ? undefined : noTestsReason(output, facts.exitCode);
    if (none !== undefined || (facts.exitCode === 0 && !facts.timedOut && count?.total === 0)) {
      this.tests = {
        ...base,
        passed: false,
        ran: "none",
        ...(none === undefined ? {} : { reason: none }),
      };
      return;
    }
    const succeeded = facts.exitCode === 0 && !facts.timedOut;
    if (succeeded && count === undefined) {
      this.tests = { ...base, passed: false, ran: "uncounted" };
      return;
    }
    this.tests = { ...base, passed: succeeded, ...(facts.timedOut ? { timedOut: true } : {}) };
  }
}

/** The first line of a command, at most 40 characters. */
export function shortCommand(command: string): string {
  const line = command.trim().split("\n")[0] ?? "";
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}
