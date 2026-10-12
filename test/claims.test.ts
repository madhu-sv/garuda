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
  // Second review: a bash allow rule (or a session answer) lets a command outside the sandbox run
  // with no question; undo restores only its snapshot (not ignored files); the sandbox also writes
  // temp folders and caches.
  /outside (?:it|the sandbox)[^.;]*always asks/i,
  /That always asks you first/i,
  /restores what a turn changed/i,
  /commands included/i,
  /writes? only in (?:the|your) project(?![\w ]*,? (?:the )?temp)/i,
  // Third review: an allow rule also covers a command on the host and an MCP call; undo restores
  // only its snapshot.
  /(?:each|every) (?:command|one|MCP tool call) asks(?: first| again| for approval)?(?![^.]*unless)/i,
  /covers every change/i,
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
  "src/sandbox/index.ts",
  "src/cli/index.ts",
];

function files(path: string): string[] {
  const full = join(repo, path);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full).flatMap((name) => files(join(path, name)));
}

/** A file's paragraphs (blank-line separated), each joined to one line, with its first line number. */
function paragraphs(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let start = 0;
  let current: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") {
      if (current.length > 0) out.push({ line: start + 1, text: current.join(" ") });
      current = [];
      return;
    }
    if (current.length === 0) start = i;
    current.push(line.trim());
  });
  if (current.length > 0) out.push({ line: start + 1, text: current.join(" ") });
  return out;
}

describe("public safety claims", () => {
  it("no text claims that every change or command asks first", () => {
    const found: string[] = [];
    for (const file of PUBLIC.flatMap(files)) {
      if (!/\.(md|astro|ts)$/.test(file)) continue;
      // Paragraphs, so a claim that wraps across lines is found too (second review).
      for (const { line, text } of paragraphs(readFileSync(file, "utf8"))) {
        // A correction note quotes the old claim on purpose.
        if (text.startsWith("*Corrected on")) continue;
        for (const claim of OVERCLAIMS) {
          const hit = claim.exec(text);
          if (hit !== null) found.push(`${relative(repo, file)}:${line}: ${hit[0]}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

/**
 * Code-intelligence claims (reviews of 1370184 and 3a9f51b): outside JS/TS the code tools match
 * names with heuristics. No text, including what the model reads, may promise AST tools.
 */
const AST_OVERCLAIMS: readonly RegExp[] = [
  /pure AST/i,
  /full AST/i,
  /deep language (?:AST )?tool/i,
  /AST (?:code )?tools/i,
  /AST investigation/i,
];

/** Public texts, and the source that writes tool descriptions and the system prompt. */
const CODE_CLAIM_TEXTS = ["README.md", "docs", "src/agents", "src/context", "src/tools"];

describe("code-intelligence claims", () => {
  it("no public or model-facing text promises AST tools", () => {
    const found: string[] = [];
    for (const file of CODE_CLAIM_TEXTS.flatMap(files)) {
      if (!/\.(md|ts)$/.test(file)) continue;
      for (const { line, text } of paragraphs(readFileSync(file, "utf8"))) {
        for (const claim of AST_OVERCLAIMS) {
          const hit = claim.exec(text);
          if (hit !== null) found.push(`${relative(repo, file)}:${line}: ${hit[0]}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
