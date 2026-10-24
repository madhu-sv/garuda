#!/usr/bin/env node
// CI check (0.17): this Node has the latest security fixes of its line. It reads the table in
// src/nodeFloor.ts, so CI and Garuda's start warning use the same versions. It exits 1 when the
// Node is older, or on a line that gets no fixes. It needs no dependencies (it runs before install).
//   node scripts/check-node.mjs [version]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The table's lines, from the source text: { 22: "22.23.4", ... }. */
export function floors(source) {
  const block = /lines:\s*\{([^}]*)\}/.exec(source)?.[1] ?? "";
  return Object.fromEntries(
    [...block.matchAll(/(\d+):\s*"(\d+\.\d+\.\d+)"/g)].map((m) => [m[1], m[2]]),
  );
}

const parse = (v) =>
  v
    .replace(/^v/, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => Number.parseInt(n, 10) || 0);

/** A reason to fail, or undefined. */
export function problem(version, table) {
  const [major] = parse(version);
  const floor = table[major];
  if (Object.keys(table).length === 0) return "src/nodeFloor.ts has no table.";
  if (floor === undefined)
    return `Node ${version} is not a line with security fixes in src/nodeFloor.ts.`;
  const [a, b] = [parse(version), parse(floor)];
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i])
      return `Node ${version} is older than ${floor}, the release with the latest security fixes.`;
    if (a[i] > b[i]) break;
  }
  return undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = join(import.meta.dirname, "..");
  const table = floors(readFileSync(join(root, "src", "nodeFloor.ts"), "utf8"));
  const version = process.argv[2] ?? process.versions.node;
  const reason = problem(version, table);
  if (reason !== undefined) {
    console.error(`check-node: ${reason}`);
    process.exit(1);
  }
  console.log(
    `check-node: Node ${version} has the latest security fixes (${table[parse(version)[0]]}).`,
  );
}
