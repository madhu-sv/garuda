import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A small repo on disk for tool tests. Call `cleanup` when done. */
export function makeSampleRepo(): { root: string; outside: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "garuda-test-"));
  const root = join(base, "repo");
  const outside = join(base, "outside");

  const files: Record<string, string> = {
    ".gitignore": "node_modules/\n*.log\nsecret/\n",
    "README.md": "# Sample\n\nA sample repo for Garuda tests.\n",
    "src/config.ts": [
      'import { readFileSync } from "node:fs";',
      "",
      "export interface Config {",
      "  name: string;",
      "}",
      "",
      "export function parseConfig(path: string): Config {",
      '  return JSON.parse(readFileSync(path, "utf8"));',
      "}",
      "",
    ].join("\n"),
    "src/main.ts": 'import { parseConfig } from "./config.js";\n\nparseConfig("app.json");\n',
    "src/util/strings.ts": "export const shout = (s: string) => s.toUpperCase();\n",
    "debug.log": "parseConfig was here\n",
    "node_modules/pkg/index.js": "function parseConfig() {}\n",
    "secret/keys.ts": "export const parseConfig = 1;\n",
    ".git/HEAD": "ref: refs/heads/main\n",
    "../outside/private.txt": "do not read\n",
  };
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  writeFileSync(join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  symlinkSync(outside, join(root, "escape"));

  // Fixed times, so "newest first" is testable: main.ts is newest.
  const t = (s: number) => new Date(2026, 0, 1, 0, 0, s);
  utimesSync(join(root, "src/config.ts"), t(1), t(1));
  utimesSync(join(root, "src/util/strings.ts"), t(2), t(2));
  utimesSync(join(root, "src/main.ts"), t(3), t(3));

  return { root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
