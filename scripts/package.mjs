#!/usr/bin/env node
// Build a standalone `garuda` binary for this machine with Node's single executable
// application support (`node --build-sea`, Node 25.5 or later).
// Usage: pnpm package   →   bin/garuda (bin/garuda.exe on Windows). It runs tsup first.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
  console.error(`pnpm package needs Node 25.5 or later (you have ${process.version}).`);
  process.exit(1);
}

const root = join(import.meta.dirname, "..");
const output = join(root, "bin", process.platform === "win32" ? "garuda.exe" : "garuda");
const config = join(root, "dist-sea", "sea-config.json");

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

mkdirSync(join(root, "bin"), { recursive: true });
writeFileSync(
  config,
  JSON.stringify(
    {
      main: join(root, "dist-sea", "garuda.cjs"),
      output,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
    },
    null,
    2,
  ),
);
run(process.execPath, ["--build-sea", config]);

// macOS runs only signed binaries on Apple silicon. An ad-hoc signature is enough locally.
if (process.platform === "darwin") run("codesign", ["--sign", "-", "--force", output]);

console.log(`\nBuilt ${output}\nTry: ${output}`);
