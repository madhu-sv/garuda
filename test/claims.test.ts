import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Public safety claims must match what Garuda does (review of 0.16.1). Edits ask first; commands
 * in the OS sandbox run with no question, inside its limits. These phrases claimed more.
 */
const OVERCLAIMS: readonly RegExp[] = [
  /every change asks/i,
  /changes ask first/i,
  /asks before it changes/i,
  /each one asks first/i,
  /a command shows its text/i,
  /coding agent that asks first/i,
  /every command runs in an OS sandbox/i,
  /an OS sandbox for every command/i,
];

const repo = join(import.meta.dirname, "..");

/** The texts that users read: README, design docs, website pages and posts, ACP mode text. */
const PUBLIC = [
  "README.md",
  "docs",
  "site/src/pages",
  "site/src/content/blog",
  "site/src/content/docs/docs/index.md",
  "site/src/content/docs/docs/install.md",
  "site/src/content/docs/docs/quick-start.md",
  "site/src/content/docs/docs/security.md",
  "site/src/content/docs/docs/editors.md",
  "site/src/seo.ts",
  "src/acp/server.ts",
];

function files(path: string): string[] {
  const full = join(repo, path);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full).flatMap((name) => files(join(path, name)));
}

describe("public safety claims", () => {
  it("no text claims that every change or command asks first", () => {
    const found: string[] = [];
    for (const file of PUBLIC.flatMap(files)) {
      if (!/\.(md|astro|ts)$/.test(file)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          // A correction note quotes the old claim on purpose.
          if (line.startsWith("*Corrected on")) return;
          for (const claim of OVERCLAIMS) {
            if (claim.test(line)) found.push(`${relative(repo, file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(found).toEqual([]);
  });
});
