import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { LanguageProfile } from "../lang/profiles.js";
import type { JobResult } from "./job.js";

/**
 * Proof of work (0.11, W2). A job's report shows the tests before and after the job, risk flags
 * from the change, and a review of the diff by the same model in a second role: a principal
 * engineer who knows the project's stack. The verdict says whether the branch is ready to merge or
 * needs a look. Everything here is pure except `detectTestCommand` (it reads files).
 */

/** One test run in the job's worktree, in the sandbox. */
export interface TestRun {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** The last lines of the output. */
  tail: string;
}

export interface RiskFlag {
  /** "stop": the branch is not ready whatever the review says. "look": the reviewer and the user should check it. */
  level: "stop" | "look";
  text: string;
}

export type Verdict = "ready" | "needs-look";

/** Lines of test output kept in the report. */
export const TEST_TAIL_LINES = 30;
/** Characters of the diff that the reviewer reads; a longer diff is cut, with the file list kept. */
export const REVIEW_DIFF_CHARS = 60_000;

/**
 * The project's test command, or undefined: a `test` script in package.json (pnpm, yarn or npm
 * by the lock file; not npm's placeholder), else the language profile's test command.
 */
export function detectTestCommand(
  root: string,
  profiles: readonly LanguageProfile[],
): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const test = pkg.scripts?.test;
    if (typeof test === "string" && test.trim() !== "" && !test.includes("no test specified")) {
      if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm test";
      if (existsSync(join(root, "yarn.lock"))) return "yarn test";
      return "npm test";
    }
  } catch {
    // No package.json, or a broken one: try the profiles.
  }
  return profiles[0]?.test;
}

/** A test run's summary for the report and the reviewer. */
export function testSummary(run: TestRun | undefined): string {
  if (run === undefined) return "not run";
  if (run.timedOut) return `stopped after ${Math.round(run.durationMs / 1000)} s (too long)`;
  return `${run.exitCode === 0 ? "pass" : `fail (exit code ${run.exitCode})`} in ${Math.round(run.durationMs / 1000)} s`;
}

export const passed = (run: TestRun | undefined) =>
  run !== undefined && !run.timedOut && run.exitCode === 0;

const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|(^|\/)src\/test\//;
const MANIFEST =
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|pyproject\.toml|requirements[^/]*\.txt|poetry\.lock|uv\.lock|pom\.xml|build\.gradle(\.kts)?|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile(\.lock)?)$/;
const DELIVERY =
  /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.yml$|Dockerfile$|docker-compose[^/]*\.ya?ml$|\.env)/;

/** Risk flags from the job's result and its test runs (pure). */
export function riskFlags(input: {
  result: Pick<JobResult, "stopReason" | "files" | "denied" | "error" | "commit">;
  test?: string;
  before?: TestRun;
  after?: TestRun;
}): RiskFlag[] {
  const { result, test, before, after } = input;
  const flags: RiskFlag[] = [];
  if (result.stopReason !== "done") {
    flags.push({
      level: "stop",
      text: `The job did not finish: it stopped with "${result.stopReason}".`,
    });
  }
  if (result.error !== undefined) flags.push({ level: "stop", text: `Error: ${result.error}` });
  if (test === undefined) {
    flags.push({ level: "look", text: "No test command: nothing proves the change works." });
  } else if (after !== undefined && !passed(after)) {
    flags.push({
      level: "stop",
      text: passed(before)
        ? "The tests passed before the job and fail after it."
        : "The tests fail after the job (they failed before it too).",
    });
  } else if (after !== undefined && before !== undefined && !passed(before)) {
    flags.push({
      level: "look",
      text: "The tests failed before the job and pass after it: check that the change is why.",
    });
  }
  const tests = result.files.filter((f) => TEST_PATH.test(f.path));
  const deletedTests = tests.filter((f) => f.status === "deleted");
  if (deletedTests.length > 0) {
    flags.push({
      level: "look",
      text: `Test files deleted: ${deletedTests.map((f) => f.path).join(", ")}.`,
    });
  }
  const changedTests = tests.filter((f) => f.status === "modified");
  if (changedTests.length > 0) {
    flags.push({
      level: "look",
      text: `Existing tests changed: ${changedTests.map((f) => f.path).join(", ")}. Check that they still test what they did.`,
    });
  }
  const manifests = result.files.filter((f) => MANIFEST.test(f.path));
  if (manifests.length > 0) {
    flags.push({
      level: "look",
      text: `Dependencies or build files changed: ${manifests.map((f) => f.path).join(", ")}.`,
    });
  }
  const delivery = result.files.filter((f) => DELIVERY.test(f.path));
  if (delivery.length > 0) {
    flags.push({
      level: "look",
      text: `CI, container or environment files changed: ${delivery.map((f) => f.path).join(", ")}.`,
    });
  }
  const lines = result.files.reduce((n, f) => n + (f.added ?? 0) + (f.removed ?? 0), 0);
  if (result.files.length > 20 || lines > 500) {
    flags.push({
      level: "look",
      text: `A large change: ${result.files.length} files, ${lines} lines.`,
    });
  }
  if (result.denied.length > 0) {
    flags.push({
      level: "look",
      text: `${result.denied.length} call(s) were denied: the job may be incomplete.`,
    });
  }
  return flags;
}

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  java: "Java",
  kt: "Kotlin",
  go: "Go",
  rs: "Rust",
  rb: "Ruby",
  cs: "C#",
  swift: "Swift",
  php: "PHP",
  scala: "Scala",
  sql: "SQL",
};

/** The stack for the reviewer's role: languages of the changed files, then the profiles. */
export function stackOf(
  files: readonly { path: string }[],
  profiles: readonly LanguageProfile[],
): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const language = LANGUAGES[extname(f.path).slice(1).toLowerCase()];
    if (language !== undefined) out.add(language);
  }
  for (const p of profiles) out.add(p.label);
  return [...out];
}

/** The reviewer's role (the system prompt): a principal engineer and domain expert. */
export function reviewerSystem(stack: readonly string[]): string {
  const expert = stack.length === 0 ? "this codebase" : `${stack.join(", ")} and this codebase`;
  return [
    `You are a principal engineer and a domain expert in ${expert}. A staff engineer made the change below`,
    "as an unattended job, from a plan that the user approved. You review it before the user merges it.",
    "Check, in this order: correctness and edge cases; that the change does what the plan says, no more and",
    "no less; that tests prove it (new behaviour tested, no test weakened); security and data risks; the",
    "project's conventions. Judge only what the diff and the facts show. Do not invent problems; say what",
    "you cannot see.",
    "",
    "Answer in exactly this form:",
    "VERDICT: ready | needs a look",
    "SUMMARY: one sentence",
    "FINDINGS:",
    "- [high|medium|low] path:line: the problem and the fix",
    '(or "- none")',
  ].join("\n");
}

/** The reviewer's input: the request, the plan, the facts and the diff (cut to a size). */
export function reviewPrompt(input: {
  prompt: string;
  files: JobResult["files"];
  test?: string;
  before?: TestRun;
  after?: TestRun;
  flags: readonly RiskFlag[];
  diff: string;
}): string {
  const diff =
    input.diff.length <= REVIEW_DIFF_CHARS
      ? input.diff
      : `${input.diff.slice(0, REVIEW_DIFF_CHARS)}\n[… the diff is cut here; ${input.diff.length - REVIEW_DIFF_CHARS} more characters]`;
  return [
    "<job>",
    input.prompt.trim(),
    "</job>",
    "",
    "<facts>",
    `Files: ${input.files.map((f) => `${f.status} ${f.path} (+${f.added ?? "?"} −${f.removed ?? "?"})`).join("; ") || "none"}`,
    `Tests (${input.test ?? "no test command"}): before the job ${testSummary(input.before)}; after it ${testSummary(input.after)}`,
    ...(input.after !== undefined && !passed(input.after)
      ? [`Test output after the job:\n${input.after.tail}`]
      : []),
    `Risk flags: ${input.flags.length === 0 ? "none" : input.flags.map((f) => f.text).join(" ")}`,
    "</facts>",
    "",
    "<diff>",
    diff,
    "</diff>",
  ].join("\n");
}

/** The reviewer's verdict and text. No "VERDICT:" line counts as "needs a look". */
export function parseReview(text: string): { verdict: Verdict; text: string } {
  const m = /^\s*VERDICT:\s*(ready|needs a look)\b/im.exec(text);
  return { verdict: m?.[1]?.toLowerCase() === "ready" ? "ready" : "needs-look", text: text.trim() };
}

/** The job's verdict: "ready" only when nothing stops it and the review (when there is one) says so. */
export function jobVerdict(flags: readonly RiskFlag[], review: Verdict | undefined): Verdict {
  if (flags.some((f) => f.level === "stop")) return "needs-look";
  return review ?? (flags.length === 0 ? "ready" : "needs-look");
}

/** The last lines of a text. */
export function tail(text: string, lines = TEST_TAIL_LINES): string {
  const all = text.trimEnd().split("\n");
  return all.length <= lines
    ? all.join("\n")
    : `[… ${all.length - lines} lines]\n${all.slice(-lines).join("\n")}`;
}
