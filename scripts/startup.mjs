#!/usr/bin/env node
// N3: Garuda must start in less than 1 s. This script loads the built CLI (all modules
// that load at startup) five times and fails if the median time is 1 s or more.
// Usage: pnpm build && pnpm startup
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const cli = join(import.meta.dirname, "..", "dist", "cli", "index.js");
const times = [];
for (let i = 0; i < 5; i++) {
  const start = performance.now();
  execFileSync(process.execPath, [cli, "--version"], { stdio: "ignore" });
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
const median = times[2];
console.log(
  `Startup: median ${median.toFixed(0)} ms (runs: ${times.map((t) => t.toFixed(0)).join(", ")} ms)`,
);
if (median >= 1000) {
  console.error("N3 fails: startup takes 1 s or more.");
  process.exit(1);
}
