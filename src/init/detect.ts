import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * What kind of folder `init` runs in (0.5): code (a build file or source files), notes (files, but
 * no code), or empty. Reads at most a few thousand entries, three levels deep; ignores dot folders
 * and dependency folders.
 */
export type FolderKind = "code" | "notes" | "empty";

const MARKERS = [
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "composer.json",
  "CMakeLists.txt",
  "Makefile",
  "deno.json",
];

const CODE = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".kt",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".cs",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".swift",
  ".scala",
  ".sh",
  ".sql",
  ".vue",
  ".svelte",
  ".dart",
]);

const SKIP = new Set(["node_modules", "target", "build", "dist", "venv", "__pycache__"]);
const MAX_ENTRIES = 5_000;

export function folderKind(root: string): FolderKind {
  if (MARKERS.some((m) => existsSync(join(root, m)))) return "code";
  let seen = 0;
  let files = 0;
  const walk = (dir: string, depth: number): boolean => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return false;
    }
    for (const name of names) {
      if (++seen > MAX_ENTRIES) return false;
      if (name.startsWith(".") || SKIP.has(name)) continue;
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (depth < 3 && walk(full, depth + 1)) return true;
        continue;
      }
      files++;
      if (CODE.has(extname(name).toLowerCase())) return true;
    }
    return false;
  };
  if (walk(root, 1)) return "code";
  return files === 0 ? "empty" : "notes";
}

/** Folders and files that show another coding agent was used here. */
const OTHER_AGENTS: [string, string][] = [
  [".claude", "Claude Code"],
  [".mcp.json", "Claude Code"],
  ["opencode.json", "OpenCode"],
  [".opencode", "OpenCode"],
  [".codex", "Codex"],
  [".gemini", "Gemini CLI"],
  ["GEMINI.md", "Gemini CLI"],
  [".tabnine", "Tabnine"],
  ["TABNINE.md", "Tabnine"],
  [".cursor", "Cursor"],
  [".cursorrules", "Cursor"],
  [".github/copilot-instructions.md", "Copilot"],
];

/**
 * A one-line hint for the chat start, or undefined: when the folder has no instruction file for
 * Garuda, or has another agent's files, /init can help.
 */
export function initTip(root: string): string | undefined {
  const others = [
    ...new Set(OTHER_AGENTS.filter(([p]) => existsSync(join(root, p))).map(([, a]) => a)),
  ];
  const hasInstructions = ["AGENTS.md", "CLAUDE.md", "GARUDA.md"].some((f) =>
    existsSync(join(root, f)),
  );
  if (others.length > 0 && !existsSync(join(root, ".garuda"))) {
    return `Found files of ${others.join(", ")}. Type /init to bring their commands, MCP servers and rules over.`;
  }
  if (hasInstructions) return undefined;
  return folderKind(root) === "code"
    ? "Type /init to write AGENTS.md: build commands, structure and conventions for the agent."
    : "This folder has no code yet. Type /init to start a project here.";
}
