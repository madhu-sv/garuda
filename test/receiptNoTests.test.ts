import { describe, expect, it } from "vitest";
import { noTestsReason, type Receipt, ReceiptCollector } from "../src/app/receipt.js";
import { receiptJson, testStatus } from "../src/cli/jsonOutput.js";
import { receiptText } from "../src/cli/receiptView.js";
import { testsText } from "../src/jobs/brief.js";
import { noTestsRan, passed, riskFlags, testSummary } from "../src/jobs/proof.js";

/**
 * Review, 2026-11: "a receipt can still say Tests passed when no tests ran". A test command that
 * succeeds passes only with a count of tests that ran; otherwise the receipt says what it knows.
 */

const facts = (exitCode: number, timedOut = false) => ({
  exitCode,
  timedOut,
  sandboxed: true,
  blockedHosts: [],
});
const collect = (command: string, output: string, exitCode = 0) => {
  const c = new ReceiptCollector(undefined);
  c.add(command, facts(exitCode), output);
  return c.tests;
};

const GRADLE_UP_TO_DATE = [
  "> Task :app:compileDebugUnitTestJavaWithJavac UP-TO-DATE",
  "> Task :app:testDebugUnitTest UP-TO-DATE",
  "",
  "BUILD SUCCESSFUL in 467ms",
].join("\n");

describe("a runner's words for 'no test ran'", () => {
  it("Gradle: every test task skipped, as in the user's Android check; one task that ran is enough", () => {
    expect(noTestsReason(GRADLE_UP_TO_DATE, 0)).toBe("Gradle: up to date");
    expect(noTestsReason("> Task :test NO-SOURCE\nBUILD SUCCESSFUL", 0)).toBe(
      "Gradle: no test sources",
    );
    expect(noTestsReason("> Task :test FROM-CACHE\nBUILD SUCCESSFUL", 0)).toBe(
      "Gradle: results from the build cache",
    );
    expect(
      noTestsReason("> Task :a:test UP-TO-DATE\n> Task :b:test\nBUILD SUCCESSFUL", 0),
    ).toBeUndefined();
    // A failed build is a failure, not "no tests".
    expect(noTestsReason(GRADLE_UP_TO_DATE, 1)).toBeUndefined();
  });

  it("go, Maven, Jest, Vitest and pytest", () => {
    expect(noTestsReason("?   	example.com/x	[no test files]", 0)).toBe("go: no test files");
    // One package with tests: tests ran.
    expect(
      noTestsReason("?   	example.com/x	[no test files]\nok  	example.com/y	0.01s", 0),
    ).toBeUndefined();
    expect(noTestsReason("[INFO] No tests to run.\n[INFO] BUILD SUCCESS", 0)).toBe(
      "Maven: no tests to run",
    );
    expect(noTestsReason("No tests found, exiting with code 0", 0)).toBe("no tests found");
    expect(noTestsReason("No test files found, exiting with code 0", 0)).toBe(
      "no test files found",
    );
    // pytest exits with 5 when it collects no test.
    expect(noTestsReason("========== no tests ran in 0.01s ==========", 5)).toBe(
      "pytest: no tests collected",
    );
    expect(noTestsReason("ok", 0)).toBeUndefined();
  });
});

describe("the receipt's tests", () => {
  it("pass only with a count of tests that ran", () => {
    expect(collect("pnpm test", "      Tests  5 passed (5)")).toEqual({
      command: "pnpm test",
      passed: true,
      total: 5,
      failed: 0,
    });
  });

  it("'no tests ran' for a runner's words or a count of 0", () => {
    expect(collect("./gradlew testDebugUnitTest --offline", GRADLE_UP_TO_DATE)).toEqual({
      command: "./gradlew testDebugUnitTest --offline",
      passed: false,
      ran: "none",
      reason: "Gradle: up to date",
    });
    expect(collect("node --test", "# tests 0\n# pass 0\n# fail 0")).toMatchObject({
      passed: false,
      ran: "none",
      total: 0,
    });
    // P1 (2026-11 review): a run whose only test is skipped ran nothing — not "passed (1 test)".
    expect(collect("node --test", "# tests 1\n# pass 0\n# fail 0\n# skipped 1")).toMatchObject({
      passed: false,
      ran: "none",
      total: 0,
    });
    expect(collect("pytest", "no tests ran in 0.01s", 5)).toMatchObject({
      passed: false,
      ran: "none",
    });
  });

  it("'uncounted' for a success with no count; failures and timeouts as before", () => {
    expect(collect("./gradlew test --offline", "BUILD SUCCESSFUL in 4s")).toEqual({
      command: "./gradlew test --offline",
      passed: false,
      ran: "uncounted",
    });
    expect(collect("pnpm test", "      Tests  1 failed | 4 passed (5)", 1)).toEqual({
      command: "pnpm test",
      passed: false,
      total: 5,
      failed: 1,
    });
    const c = new ReceiptCollector(undefined);
    c.add("pnpm test", facts(1, true), "");
    expect(c.tests).toEqual({ command: "pnpm test", passed: false, timedOut: true });
  });
});

const receipt = (tests: Receipt["tests"]): Receipt => ({
  turn: 1,
  stopReason: "done",
  steps: 2,
  durationMs: 1_000,
  costUsd: 0,
  files: [{ path: "a.ts", added: 1, removed: 0 }],
  ...(tests === undefined ? {} : { tests }),
  commands: { sandboxed: 1, outside: 0, blockedHosts: [] },
  contextPercent: 1,
  sessionCostUsd: 0,
  keptChanges: 1,
});

describe("what the receipt and the JSON result say", () => {
  it("the view never says 'passed' without tests", () => {
    const none = receiptText(
      receipt({
        command: "./gradlew test",
        passed: false,
        ran: "none",
        reason: "Gradle: up to date",
      }),
      { columns: 100 },
    );
    expect(none).toContain("./gradlew test ○ no tests ran (Gradle: up to date)");
    expect(none).not.toContain("passed");
    const uncounted = receiptText(
      receipt({ command: "./gradlew test", passed: false, ran: "uncounted" }),
      { columns: 100 },
    );
    expect(uncounted).toContain("./gradlew test exit 0, no test count");
    expect(uncounted).not.toContain("passed");
  });

  it("JSON: passed is true only for tests that passed; status names the case", () => {
    expect(testStatus({ command: "t", passed: true, total: 2, failed: 0 })).toBe("passed");
    expect(testStatus({ command: "t", passed: false, total: 2, failed: 1 })).toBe("failed");
    expect(testStatus({ command: "t", passed: false, timedOut: true })).toBe("timed_out");
    expect(testStatus({ command: "t", passed: false, ran: "none" })).toBe("no_tests");
    expect(testStatus({ command: "t", passed: false, ran: "uncounted" })).toBe("uncounted");
    expect(
      receiptJson(
        receipt({ command: "t", passed: false, ran: "none", reason: "go: no test files" }),
      ),
    ).toMatchObject({
      tests: { passed: false, status: "no_tests", reason: "go: no test files" },
    });
  });
});

describe("a job's proof of work", () => {
  const run = (tail: string, exitCode = 0) => ({
    exitCode,
    timedOut: false,
    durationMs: 2_000,
    tail,
  });

  it("a successful run with no test does not pass, and stops a 'ready' verdict", () => {
    const after = run(GRADLE_UP_TO_DATE);
    expect(noTestsRan(after)).toBe("Gradle: up to date");
    expect(passed(after)).toBe(false);
    expect(testSummary(after)).toBe("no tests ran (Gradle: up to date) in 2 s");
    const flags = riskFlags({
      result: { stopReason: "done", files: [], denied: 0, commit: "abc" } as never,
      test: "./gradlew test",
      before: run("      Tests  5 passed (5)"),
      after,
    });
    expect(flags).toContainEqual({
      level: "stop",
      text: "The test command ran no test after the job (Gradle: up to date): nothing proves the change works.",
    });
    // The morning brief too.
    expect(testsText({ result: { proof: { after } } } as never)).toBe("no tests ran");
    // Tests that ran still pass.
    expect(passed(run("      Tests  5 passed (5)"))).toBe(true);
    expect(testSummary(run("      Tests  5 passed (5)"))).toBe("pass in 2 s");
  });
});
