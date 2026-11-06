import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { folderKind } from "../init/detect.js";
import { detectTestCommand } from "../jobs/proof.js";
import type { LanguageProfile } from "../lang/profiles.js";

/**
 * The first-run tour (UX U9; docs/lld/ux.md): the first chat in a project names what the project
 * is and offers three first tasks; typing 1, 2 or 3 runs one. It shows once per project
 * (`~/.garuda/ui.json`, `toured`: a hash of each root, never the path itself).
 */

export interface Stack {
  /** For example "TypeScript with vitest (pnpm)". */
  label: string;
  /** The project's test command, when Garuda knows it. */
  test?: string;
}

/** What the project is, from its files; undefined when Garuda cannot tell. */
export function detectStack(root: string, profiles: readonly LanguageProfile[]): Stack | undefined {
  const has = (name: string) => existsSync(join(root, name));
  const test = detectTestCommand(root, profiles);
  const withTest = (label: string): Stack => (test === undefined ? { label } : { label, test });
  if (has("package.json")) {
    let deps: Record<string, unknown> = {};
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      deps = { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {
      // A broken package.json: the language only.
    }
    const language = has("tsconfig.json") || "typescript" in deps ? "TypeScript" : "JavaScript";
    const runner = ["vitest", "jest", "mocha"].find((r) => r in deps);
    const manager = has("pnpm-lock.yaml")
      ? "pnpm"
      : has("yarn.lock")
        ? "yarn"
        : has("bun.lockb")
          ? "bun"
          : "npm";
    const app = "react-native" in deps ? " (React Native)" : "expo" in deps ? " (Expo)" : "";
    return withTest(
      `${language}${app}${runner === undefined ? "" : ` with ${runner}`} (${manager})`,
    );
  }
  const profile = profiles[0];
  if (profile !== undefined) return withTest(profile.label);
  if (has("go.mod")) return withTest("Go");
  if (has("Cargo.toml")) return withTest("Rust");
  return undefined;
}

/** The three first tasks: the layout, the tests (or the riskiest code), one missing test. */
export function tourPrompts(stack: Stack): string[] {
  return [
    "Explain how this repository is laid out, in 10 lines or fewer.",
    stack.test === undefined
      ? "Find the riskiest function in this codebase and say why, in 5 lines."
      : `Run the tests (${stack.test}) and explain any failure.`,
    "Find one function that has no test, and write a test for it.",
  ];
}

/** The tour's lines, for the start banner. */
export function tourText(stack: Stack, prompts: readonly string[]): string {
  return [
    `This looks like ${stack.label}. Some first tasks:`,
    ...prompts.map((p, i) => `  ${i + 1}. ${p}`),
    "Type a number, or your own task.",
  ].join("\n");
}

const rootKey = (root: string) => createHash("sha256").update(root).digest("hex").slice(0, 16);
/** Most projects that ui.json remembers. */
const MAX_TOURED = 200;

/**
 * The tour for this chat start, once per project: undefined for a folder with no code, one
 * Garuda cannot name, or one that had the tour. A home folder that cannot be written shows it
 * again next time, nothing worse.
 */
export async function firstRunTour(
  root: string,
  home: string,
  profiles: readonly LanguageProfile[],
): Promise<{ text: string; prompts: string[] } | undefined> {
  if (folderKind(root) !== "code") return undefined;
  const stack = detectStack(root, profiles);
  if (stack === undefined) return undefined;
  const file = join(home, ".garuda", "ui.json");
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    // No file yet.
  }
  const toured = Array.isArray(data.toured)
    ? data.toured.filter((t): t is string => typeof t === "string")
    : [];
  const key = rootKey(root);
  if (toured.includes(key)) return undefined;
  try {
    await mkdir(join(home, ".garuda"), { recursive: true, mode: 0o700 });
    const next = { ...data, toured: [...toured, key].slice(-MAX_TOURED) };
    await writeFile(file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  } catch {
    // Shown again next time.
  }
  const prompts = tourPrompts(stack);
  return { text: tourText(stack, prompts), prompts };
}

/** The first input "1", "2" or "3" after the tour becomes that task; anything else stays. */
export function tourChoice(input: string, prompts: readonly string[] | undefined): string {
  const n = /^\s*([1-9])\s*$/.exec(input)?.[1];
  return prompts !== undefined && n !== undefined ? (prompts[Number(n) - 1] ?? input) : input;
}
