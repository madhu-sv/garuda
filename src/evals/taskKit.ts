import { lines, MAVEN_CHECK, PYTEST_CHECK } from "./projects.js";

/**
 * Helpers for written eval tasks (0.17, T11c): a Node package, test files, hidden tests and
 * mutation checks.
 *
 * TypeScript tasks run with Node's own type stripping (`node --test`, Node 22.18 or later), so
 * their code uses only erasable syntax: no parameter properties, enums or namespaces.
 *
 * Hidden tests: the check writes them after the run (into .check/), so the agent never sees them.
 * Mutation checks: the agent's tests must pass on the real code and fail on each mutant.
 */

export const NODE_PKG = lines("{", '  "type": "module",', '  "private": true', "}");

/** Imports for a node:test file. */
export const testHead = (...imports: string[]) =>
  lines(
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    ...imports,
  );

/**
 * A check that runs a hidden test file after the visible ones. The hidden file is written into
 * .check/ (after Garuda took the run's changed files, so it is not a change of the agent).
 */
export const hiddenNode = (name: string, body: string, before = "") =>
  `${writeHidden(name, body)}${before}node --test "test/**/*.test.ts" .check/${name}`;

export const hiddenPytest = (name: string, body: string, before = "") =>
  `${writeHidden(name, body)}${before}${PYTEST_CHECK} tests .check/${name}`;

/**
 * Write the hidden file first: the heredoc ends a line, so the command after it is a new list, and
 * `before` (a chain of `&&` tests) must be on the same line as the test command it guards.
 */
export const writeHidden = (name: string, body: string) =>
  `mkdir -p .check && cat > .check/${name} <<'GARUDA_HIDDEN'\n${body}GARUDA_HIDDEN\n`;

/**
 * A mutation check: the agent's test command passes on the real code, then fails on each mutant.
 * Each mutant is a sed expression on one file, applied to a copy of the project.
 */
export function mutationCheck(file: string, testCommand: string, mutants: string[]): string {
  const each = mutants
    .map(
      (m) =>
        `rm -rf "$d/p" && cp -R . "$d/p" && sed -i.orig ${shellWord(m)} "$d/p/${file}" && ! cmp -s "${file}" "$d/p/${file}" && (cd "$d/p" && ! ${testCommand} >/dev/null 2>&1)`,
    )
    .join(" && ");
  return `${testCommand} && d=$(mktemp -d) && ${each}`;
}

export function shellWord(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** A hidden JUnit test, written into the project's test sources, then Maven runs every test. */
export const hiddenMaven = (path: string, body: string) =>
  `mkdir -p "$(dirname ${path})" && cat > ${path} <<'GARUDA_HIDDEN'\n${body}GARUDA_HIDDEN\n${MAVEN_CHECK}`;
