import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { displayPath, resolveInRoot } from "../permissions/pathGuard.js";
import { writeFileAtomic } from "./atomicWrite.js";
import { unifiedDiff } from "./diff.js";
import { splitLines } from "./limits.js";
import { type Tool, withDiagnostics } from "./types.js";

const input = z.object({
  path: z.string().min(1).describe("Path of the new file, relative to the working root."),
  content: z.string().describe("The full content of the new file."),
});

/** write_file (F10): create a new file only. It fails if the file exists. */
export const writeFileTool: Tool<z.infer<typeof input>> = {
  name: "write_file",
  description: [
    "Create a new file in the working root with the given content. Missing folders are created.",
    "It fails if the file already exists. To change an existing file, use edit_file.",
    "The user must approve each write.",
  ].join("\n"),
  inputSchema: input,
  readOnly: false,

  async describe({ path, content }, { root }) {
    const shown = displayPath(root, await resolveInRoot(root, path));
    return { target: { kind: "path", path: shown }, preview: unifiedDiff(shown, "", content) };
  },

  async run({ path, content }, context) {
    const { root, files } = context;
    const absolute = await resolveInRoot(root, path);
    const shown = displayPath(root, absolute);
    await mkdir(dirname(absolute), { recursive: true });
    try {
      // Create-only and atomic: it fails if the file exists, and never leaves half a file.
      await writeFileAtomic(absolute, content, { createOnly: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`${shown} already exists. Read it, then use edit_file to change it.`);
      }
      throw error;
    }
    // The agent knows this content, so it can edit the file next without a read.
    files.record(absolute, content);
    return withDiagnostics(`Created ${shown} (${splitLines(content).length} lines).`, context, {
      absolute,
      shown,
      text: content,
    });
  },
};
