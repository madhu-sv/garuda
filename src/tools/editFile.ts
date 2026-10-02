import { readFile } from "node:fs/promises";
import { z } from "zod";
import { displayPath, resolveInRoot } from "../permissions/pathGuard.js";
import { writeFileAtomic } from "./atomicWrite.js";
import { applyHunks, previewIsComplete, unifiedDiff } from "./diff.js";
import { afterWrite, type Tool, type ToolContext } from "./types.js";

const input = z.object({
  path: z.string().min(1).describe("File path, relative to the working root."),
  old_string: z
    .string()
    .min(1)
    .describe("The exact text to replace. It must occur exactly once in the file."),
  new_string: z.string().describe("The replacement text."),
});

type Input = z.infer<typeof input>;

interface PlannedEdit {
  absolute: string;
  shown: string;
  before: string;
  after: string;
}

/**
 * edit_file (F11): replace one exact string.
 * It fails on zero or several matches, and when the file changed after the last read_file.
 */
export const editFileTool: Tool<Input> = {
  name: "edit_file",
  description: [
    "Replace one exact string in an existing file.",
    "old_string must match the file exactly, including spaces and indentation, and occur exactly once.",
    "Add surrounding lines to old_string to make it unique.",
    "Read the file with read_file first. The edit fails if the file changed after that read.",
    "The user must approve each edit.",
  ].join("\n"),
  inputSchema: input,
  readOnly: false,

  // Plan the edit before approval, so the user sees the real diff and a bad edit fails early.
  async describe(args, context) {
    const edit = await plan(args, context);
    const preview = unifiedDiff(edit.shown, edit.before, edit.after);
    return {
      target: { kind: "path", path: edit.shown },
      preview,
      // Hunk-by-hunk approval only when the user sees every hunk (U0).
      ...(previewIsComplete(preview) ? { hunks: true as const } : {}),
    };
  },

  async run(args, context) {
    // Plan again: the file can change while the user decides.
    const edit = await plan(args, context);
    let text = edit.after;
    let note = "";
    const accepted = context.approvedHunks;
    if (accepted !== undefined) {
      // U0: write only the hunks the user accepted, and only if the change is still the one they
      // saw (the same preview); else write nothing.
      const preview = unifiedDiff(edit.shown, edit.before, edit.after);
      if (context.approvedPreview !== undefined && preview !== context.approvedPreview) {
        throw new Error(
          `${edit.shown} changed while the user reviewed the hunks. Nothing was written. Read the file again.`,
        );
      }
      const total = (preview.match(/^@@ /gm) ?? []).length;
      text = applyHunks(edit.before, edit.after, accepted);
      const rejected = Array.from({ length: total }, (_, i) => i).filter(
        (i) => !accepted.includes(i),
      );
      note = ` The user accepted ${accepted.length} of ${total} hunk(s) and rejected hunk(s) ${rejected.map((i) => i + 1).join(", ")}: only the accepted ones were written, so the file differs from your edit. Read it before you change it again.`;
    }
    await writeFileAtomic(edit.absolute, text, { createOnly: false });
    context.files.record(edit.absolute, text);
    return afterWrite(`Edited ${edit.shown}.${note}`, context, {
      absolute: edit.absolute,
      shown: edit.shown,
      text,
    });
  },
};

async function plan(args: Input, { root, files }: ToolContext): Promise<PlannedEdit> {
  const absolute = await resolveInRoot(root, args.path);
  const shown = displayPath(root, absolute);
  if (args.old_string === args.new_string) {
    throw new Error("old_string and new_string are the same. There is nothing to change.");
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`${shown} does not exist. Use write_file to create it.`);
    if (code === "EISDIR") throw new Error(`${shown} is a folder.`);
    throw error;
  }

  const status = files.status(absolute, buffer);
  if (status === "unread") throw new Error(`Read ${shown} with read_file before you edit it.`);
  if (status === "changed") {
    throw new Error(`${shown} changed after your last read. Read it again, then retry the edit.`);
  }

  const before = buffer.toString("utf8");
  const count = countOccurrences(before, args.old_string);
  if (count === 0) {
    throw new Error(`old_string was not found in ${shown}. Check spaces and indentation.`);
  }
  if (count > 1) {
    throw new Error(
      `old_string occurs ${count} times in ${shown}. Add surrounding lines to make it unique.`,
    );
  }
  // A function replacement, so "$&" and similar in new_string stay literal.
  const after = before.replace(args.old_string, () => args.new_string);
  return { absolute, shown, before, after };
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  for (let at = text.indexOf(search); at !== -1; at = text.indexOf(search, at + search.length)) {
    count++;
  }
  return count;
}
