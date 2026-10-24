#!/usr/bin/env node
// Build the macOS helper native/bin/garuda-reap from native/garuda-reap.c (0.17, IPI-04): a
// universal arm64 + x86_64 binary with an ad-hoc signature. On other platforms it does nothing.
// `pnpm build` and `pnpm test` run it; it rebuilds only when the source is newer than the binary.
//   node scripts/build-native.mjs [--require]
//   --require  fail when the helper cannot be built (the release workflow)
// Without the helper, Garuda on macOS warns (default profile) or refuses sandboxed commands (strict).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const source = join(root, "native", "garuda-reap.c");
const output = join(root, "native", "bin", "garuda-reap");
const required = process.argv.includes("--require");

function stop(message) {
  if (required) {
    console.error(`build-native: ${message}`);
    process.exit(1);
  }
  console.log(`build-native: ${message} Skipped.`);
  process.exit(0);
}

if (process.platform !== "darwin") {
  if (required) stop("the helper is for macOS only.");
  process.exit(0);
}
if (!required && existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) {
  process.exit(0);
}
try {
  execFileSync("clang", ["--version"], { stdio: "ignore" });
} catch {
  stop("clang is missing (install the Command Line Tools: xcode-select --install).");
}

mkdirSync(join(root, "native", "bin"), { recursive: true });
const temp = `${output}.tmp`;
rmSync(temp, { force: true });
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
run("clang", [
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-arch",
  "arm64",
  "-arch",
  "x86_64",
  "-mmacosx-version-min=12.0",
  "-o",
  temp,
  source,
]);
// Apple silicon runs only signed code; an ad-hoc signature is enough.
run("codesign", ["--sign", "-", "--force", temp]);
const archs = execFileSync("lipo", ["-archs", temp], { encoding: "utf8" }).trim().split(/\s+/);
if (!archs.includes("arm64") || !archs.includes("x86_64")) {
  rmSync(temp, { force: true });
  stop(`the helper has architectures ${archs.join(", ")}, not arm64 and x86_64.`);
}
chmodSync(temp, 0o755);
renameSync(temp, output);
console.log(`build-native: built ${output} (${archs.join(", ")}).`);
