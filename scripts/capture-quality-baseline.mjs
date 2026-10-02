#!/usr/bin/env node
/** M0 evidence only: no live model requests, installations, or environment-value dumps. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const outputArg = args.indexOf("--output");
const contextArg = args.indexOf("--execution-context");
if (args.includes("--help")) {
  console.log(
    "node scripts/capture-quality-baseline.mjs [--output directory] [--execution-context label]",
  );
  process.exit(0);
}
const output = resolve(
  root,
  outputArg < 0 ? `.garuda/evidence/quality-baseline/${Date.now()}` : args[outputArg + 1],
);
mkdirSync(output, { recursive: true });
if (readdirSync(output).length !== 0) throw new Error("Use a new empty evidence directory.");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const git = (...command) => {
  const result = spawnSync("git", command, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${command.join(" ")} failed`);
  return result.stdout.trim();
};
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const baseline = {
  version: 1,
  capturedAt: new Date().toISOString(),
  executionContext: contextArg < 0 ? "unspecified" : args[contextArg + 1],
  commit: git("rev-parse", "HEAD"),
  branch: git("branch", "--show-current"),
  trackedChanges: git("status", "--short", "--untracked-files=no"),
  trackedDiffSha256: sha256(git("diff", "HEAD", "--binary")),
  untrackedSourceFiles: git(
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "src",
    "test",
    "scripts",
    "docs/quality-baseline",
  ),
  lockfileSha256: sha256(readFileSync(join(root, "pnpm-lock.yaml"))),
  package: { version: pkg.version, packageManager: pkg.packageManager },
  runtime: { node: process.version, platform: platform(), arch: arch(), osRelease: release() },
  models: {
    provider: "fake",
    networkRequests: 0,
    paidEvaluations: "not run",
    configuration: "test/known-agent-gaps.test.ts",
  },
  executorProbes: [],
  checks: [],
};
// Include the tested bytes, even when new source files have not been committed yet.
const sources = git(
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "--",
  "src",
  "test",
  "scripts",
  "docs/quality-baseline",
  "package.json",
)
  .split("\n")
  .filter(Boolean);
baseline.sourceSha256 = Object.fromEntries(
  [...new Set(sources)].sort().map((path) => [path, sha256(readFileSync(join(root, path)))]),
);
const probes =
  platform() === "darwin"
    ? [
        [
          "seatbelt",
          "/usr/bin/sandbox-exec",
          ["-p", "(version 1)(allow default)", "--", "/usr/bin/true"],
        ],
      ]
    : platform() === "linux"
      ? [
          [
            "bubblewrap",
            "bwrap",
            [
              "--ro-bind",
              "/",
              "/",
              "--dev",
              "/dev",
              "--unshare-net",
              "--die-with-parent",
              "--",
              "true",
            ],
          ],
        ]
      : [];
for (const [name, command, commandArgs] of probes) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", timeout: 5000 });
  baseline.executorProbes.push({
    name,
    available: result.status === 0,
    status: result.status,
    reason:
      result.status === 0
        ? "process launch probe only; containment is tested separately"
        : (result.error?.message ?? result.stderr.trim()).slice(0, 400),
  });
}
let failed = false;
const checks = [
  ["typecheck", ["typecheck"], {}],
  ["lint", ["lint"], {}],
  [
    "tests",
    [
      "exec",
      "vitest",
      "run",
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${join(output, "tests.json")}`,
    ],
    {},
  ],
  [
    "known-gap-reproductions",
    [
      "exec",
      "vitest",
      "run",
      "test/known-agent-gaps.test.ts",
      "--reporter=json",
      `--outputFile=${join(output, "known-gap-reproductions.json")}`,
    ],
    { GARUDA_GAP_REPRO_STRICT: "1" },
  ],
];
for (const [name, command, env] of checks) {
  console.log(`Quality baseline: ${name}`);
  const started = Date.now();
  const result = spawnSync("pnpm", command, {
    cwd: root,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, GARUDA_GAP_REPRO_STRICT: "0", ...env },
  });
  writeFileSync(join(output, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`, {
    mode: 0o600,
  });
  const status = {
    name,
    command: `pnpm ${command.join(" ")}`,
    exitCode: result.status,
    durationMs: Date.now() - started,
    completed: result.error === undefined,
  };
  if (name === "known-gap-reproductions") {
    try {
      const report = JSON.parse(readFileSync(join(output, "known-gap-reproductions.json"), "utf8"));
      const assertions = report.testResults.flatMap((file) => file.assertionResults);
      const expected = JSON.parse(
        readFileSync(join(root, "docs/quality-baseline/known-gap-contracts.json"), "utf8"),
      );
      status.reproduced = assertions
        .filter(
          (test) =>
            test.status === "failed" &&
            test.failureMessages.some(
              (message) =>
                /AssertionError|promise resolved/.test(message) &&
                expected.failurePatterns[test.title] !== undefined &&
                message.includes(expected.failurePatterns[test.title]),
            ),
        )
        .map((test) => test.title);
      const resolvedScenarios = expected.resolvedScenarios ?? [];
      status.resolved = assertions
        .filter((test) => test.status === "passed" && resolvedScenarios.includes(test.title))
        .map((test) => test.title);
      status.evidenceValid =
        result.error === undefined &&
        result.status === (expected.scenarios.length > 0 ? 1 : 0) &&
        assertions.length === expected.scenarios.length + resolvedScenarios.length &&
        expected.scenarios.every((title) => status.reproduced.includes(title)) &&
        resolvedScenarios.every((title) => status.resolved.includes(title));
      status.safetyGate = "blocked: reproduced open contracts are not safety passes";
      if (!status.evidenceValid) failed = true;
    } catch {
      status.evidenceValid = false;
      failed = true;
    }
  } else if (result.error !== undefined || result.status !== 0) failed = true;
  baseline.checks.push(status);
}
try {
  const report = JSON.parse(readFileSync(join(output, "tests.json"), "utf8"));
  baseline.tests = {
    files: report.testResults.length,
    total: report.numTotalTests,
    reportedPassed: report.numPassedTests,
    openExpectedFailures:
      baseline.checks.find((check) => check.name === "known-gap-reproductions")?.reproduced
        ?.length ?? 0,
    failed: report.numFailedTests,
    pending: report.numPendingTests,
    success: report.success,
  };
  baseline.skips = report.testResults.flatMap((file) =>
    file.assertionResults
      .filter((test) => ["pending", "skipped", "todo"].includes(test.status))
      .map((test) => ({
        file: relative(root, file.name),
        title: test.fullName,
        reason:
          file.name.endsWith("/test/lsp.java.test.ts") &&
          test.fullName.includes("Java: the real jdtls (opt-in)")
            ? "Requires an OS sandbox and opt-in GARUDA_TEST_JDTLS=1 (test/lsp.java.test.ts)."
            : /\(skipped:/i.test(test.fullName)
              ? "see prerequisite hint in test title"
              : "not reported by runner; inspect this named test before claiming coverage",
      })),
  );
} catch {
  baseline.tests = { reportAvailable: false };
  failed = true;
}
baseline.evidenceComplete = !failed;
baseline.releaseSafetyGate = "blocked pending M1 to M4 fixes; this is an M0 baseline";
writeFileSync(join(output, "manifest.json"), `${JSON.stringify(baseline, null, 2)}\n`, {
  mode: 0o600,
});
console.log(`Quality baseline evidence: ${join(output, "manifest.json")}`);
process.exitCode = failed ? 1 : 0;
