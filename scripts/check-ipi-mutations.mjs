#!/usr/bin/env node
// Mutation check for the IPI suite (test/ipiSuite.test.ts): for each case, remove the defence that
// the case relies on, run that case, and expect it to FAIL. A case that still passes does not test
// the defence. The source files are restored with `git checkout` after each run, so the script
// refuses to start when one of them has uncommitted changes.
// Usage: pnpm ipi:mutations
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const groupKill =
  '        // Background children may still hold the group. Stop them too.\n        if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");';
const unsharePid = [
  'args.push("--unshare-pid", "--proc", "/proc");',
  'args.push("--proc", "/proc");',
];
const addressCheck = [
  '  if (range === "unicast") return { ok: true };',
  '  if (range !== "never") return { ok: true };',
];

/** [test name filter, [[file, text, replacement], …]]. All replacements of one case apply together. */
const MUTATIONS = [
  [
    "IPI-01",
    [
      [
        "src/permissions/sandboxPaths.ts",
        'export const PROTECTED_IN_ROOT = [".git/hooks", ".git/config", ".garuda"];',
        "export const PROTECTED_IN_ROOT: string[] = [];",
      ],
    ],
  ],
  [
    "IPI-02",
    [
      [
        "src/permissions/pathGuard.ts",
        "  if (!isInside(realRoot, realTarget)) throw new PathOutsideRootError(input);\n  return absolute;",
        "  void realRoot;\n  void realTarget;\n  return absolute;",
      ],
    ],
  ],
  [
    "IPI-04: a background",
    [
      ["src/sandbox/process.ts", groupKill, "        // mutation: no group kill"],
      ["src/sandbox/bwrap.ts", ...unsharePid],
    ],
  ],
  ["IPI-04: a new session", [["src/sandbox/bwrap.ts", ...unsharePid]]],
  [
    "IPI-05",
    [
      [
        "src/permissions/rules.ts",
        '} else if (";&|\\n`()".includes(c) || (c === "$" && command[i + 1] === "(")) {',
        "} else if (false) {",
      ],
    ],
  ],
  [
    "IPI-06",
    [
      [
        "src/tools/readFile.ts",
        'return { target: { kind: "path", path: displayPath(root, await resolveInRoot(root, path)) } };',
        'return { target: { kind: "path", path } };',
      ],
      [
        "src/permissions/engine.ts",
        "      const real = await realRelative(this.root, target.path);",
        "      const real = undefined as string | undefined;\n      void realRelative;",
      ],
    ],
  ],
  [
    "IPI-07",
    [
      [
        "src/permissions/projectSettings.ts",
        "    allow: settings.allow.map(formatRule),",
        "    allow: [],",
      ],
    ],
  ],
  ["IPI-08", [["src/net/address.ts", ...addressCheck]]],
  ["IPI-09", [["src/net/address.ts", ...addressCheck]]],
  [
    "IPI-10: a newline",
    [
      [
        "src/session/redact.ts",
        "  /sk-ant-[A-Za-z0-9_-]{16,}/g,\n  /\\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,",
        "",
      ],
    ],
  ],
  [
    "IPI-10: escape",
    [
      [
        "src/cli/approver.ts",
        ".replace(/[\\u0000-\\u0008\\u000b-\\u001f]/g,",
        ".replace(/[\\u0000-\\u0008\\u000b-\\u001a]/g,",
      ],
    ],
  ],
];

const files = [...new Set(MUTATIONS.flatMap(([, changes]) => changes.map(([f]) => f)))];
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], {
  cwd: root,
  encoding: "utf8",
});
if (dirty.trim() !== "") {
  console.error(
    `Commit or stash these files first; the check restores them with git checkout:\n${dirty}`,
  );
  process.exit(2);
}

let missed = 0;
for (const [name, changes] of MUTATIONS) {
  const touched = [];
  try {
    for (const [file, text, replacement] of changes) {
      const path = join(root, file);
      const source = readFileSync(path, "utf8");
      if (!source.includes(text))
        throw new Error(`${file}: the defence's code changed; update this script`);
      writeFileSync(path, source.replace(text, replacement));
      touched.push(file);
    }
    const run = spawnSync("npx", ["vitest", "run", "test/ipiSuite.test.ts", "-t", name], {
      cwd: root,
      encoding: "utf8",
    });
    const tests = /Tests\s+(.*)/.exec(`${run.stdout}${run.stderr}`)?.[1]?.trim() ?? "?";
    const skippedAll = /^\d+ skipped/.test(tests);
    const caught = run.status !== 0;
    if (!caught && !skippedAll) missed++;
    console.log(
      `${name.padEnd(22)} ${skippedAll ? "SKIPPED (no OS sandbox here)" : caught ? "caught" : "NOT CAUGHT"}  (${tests})`,
    );
  } catch (error) {
    missed++;
    console.log(`${name.padEnd(22)} ERROR: ${error.message}`);
  } finally {
    if (touched.length > 0) execFileSync("git", ["checkout", "--", ...touched], { cwd: root });
  }
}
console.log(
  missed === 0
    ? "Every case fails without its defence."
    : `${missed} case(s) did not fail without their defence.`,
);
process.exit(missed === 0 ? 0 : 1);
