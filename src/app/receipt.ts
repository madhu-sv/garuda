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
  passed: boolean;
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
  /(^|[\s;&|(/])(vitest|jest|pytest|py\.test|mvn|mvnw|gradle|gradlew|go\s+test|node\s+--test|(npm|pnpm|yarn|bun)\s+(run\s+)?test|cargo\s+test|tox|nox)\b/;

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
  // vitest: "Tests  2 failed | 122 passed (124)"
  const vitest = /^\s*Tests\s+(.*\b(?:passed|failed|skipped)\b.*?)\s+\((\d+)\)\s*$/m.exec(output);
  if (vitest !== null) {
    return { total: num(vitest[2]), failed: num(/(\d+) failed/.exec(vitest[1] ?? "")?.[1]) };
  }
  // jest: "Tests:       2 failed, 122 passed, 124 total"
  const jest = /^Tests:\s+(?:(\d+) failed, )?.*?(\d+) total\s*$/m.exec(output);
  if (jest !== null) return { total: num(jest[2]), failed: num(jest[1]) };
  // node:test (tap or spec): "# tests 124" / "ℹ tests 124", and "fail 2"
  const nodeTotal = /^(?:#|ℹ) tests (\d+)\s*$/m.exec(output);
  if (nodeTotal !== null) {
    return { total: num(nodeTotal[1]), failed: num(/^(?:#|ℹ) fail (\d+)\s*$/m.exec(output)?.[1]) };
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
  // go test -v: one line per test.
  const passes = output.match(/^\s*--- PASS: /gm)?.length ?? 0;
  const fails = output.match(/^\s*--- FAIL: /gm)?.length ?? 0;
  if (passes + fails > 0) return { total: passes + fails, failed: fails };
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
    const passed = facts.exitCode === 0 && !facts.timedOut;
    this.tests = {
      command: shortCommand(command),
      passed,
      ...(facts.timedOut ? { timedOut: true } : {}),
      ...(count === undefined ? {} : { total: count.total, failed: count.failed }),
    };
  }
}

/** The first line of a command, at most 40 characters. */
export function shortCommand(command: string): string {
  const line = command.trim().split("\n")[0] ?? "";
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}
