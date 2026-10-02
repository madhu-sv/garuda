import { stat } from "node:fs/promises";
import { z } from "zod";
import { displayPath, resolveInRoot } from "../permissions/pathGuard.js";
import { isDirectory, listFiles } from "./files.js";
import { LIMITS } from "./limits.js";
import type { Tool } from "./types.js";

const input = z.object({
  pattern: z.string().min(1).describe('Glob pattern, for example "**/*.ts" or "src/**/index.*".'),
  path: z
    .string()
    .optional()
    .describe("Folder to search, relative to the working root. Default: the working root."),
});

export interface GlobOutput {
  files: string[];
  total: number;
}

/** glob (F12): find files by pattern, newest first. Respects .gitignore. */
export const globTool: Tool<z.infer<typeof input>, GlobOutput> = {
  name: "glob",
  description: [
    "Find files by name pattern in the working root. Respects .gitignore.",
    `Returns paths relative to the working root, newest first, at most ${LIMITS.globResults}.`,
  ].join("\n"),
  inputSchema: input,
  readOnly: true,

  async run({ pattern, path = "." }, { root, permissions }) {
    const base = await resolveInRoot(root, path);
    if (!(await isDirectory(base))) throw new Error(`${path} is not a folder.`);

    // Team policy denyPaths (G04): a denied file is not listed.
    const paths = (await listFiles(base, pattern, root)).filter(
      (p) => !permissions.deniedByPolicy(displayPath(root, p)),
    );
    const withTimes = await Promise.all(
      paths.map(async (p) => ({ p, mtime: (await stat(p).catch(() => undefined))?.mtimeMs ?? 0 })),
    );
    withTimes.sort((a, b) => b.mtime - a.mtime || a.p.localeCompare(b.p));

    return {
      files: withTimes.slice(0, LIMITS.globResults).map(({ p }) => displayPath(root, p)),
      total: withTimes.length,
    };
  },

  toText({ files, total }) {
    if (total === 0) return "No files match.";
    const note =
      total > files.length
        ? `\n\n[${files.length} of ${total} files. Use a narrower pattern.]`
        : "";
    return files.join("\n") + note;
  },
};
