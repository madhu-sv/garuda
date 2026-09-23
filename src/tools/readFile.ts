import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { displayPath, resolveInRoot } from "../permissions/pathGuard.js";
import { cutLine, joinWithinLimit, LIMITS, looksBinary, splitLines } from "./limits.js";
import type { Tool } from "./types.js";

const input = z.object({
  path: z.string().min(1).describe("File path, relative to the working root."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("First line to read, starting at 1. Default: 1."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.readLines)
    .optional()
    .describe(`Number of lines to read. Default and maximum: ${LIMITS.readLines}.`),
});

/** read_file (F9): numbered lines, offset and limit, output cap. */
export const readFileTool: Tool<z.infer<typeof input>> = {
  name: "read_file",
  description: [
    "Read a text file in the working root. Lines come back numbered, like `cat -n`.",
    `It returns at most ${LIMITS.readLines} lines per call. Use offset and limit to read large files in parts.`,
    "It refuses folders (use glob) and binary files.",
  ].join("\n"),
  inputSchema: input,
  readOnly: true,

  async describe({ path }, { root }) {
    return { target: { kind: "path", path: displayPath(root, await resolveInRoot(root, path)) } };
  },

  async run({ path, offset = 1, limit = LIMITS.readLines }, { root, files }) {
    const absolute = await resolveInRoot(root, path);
    const shown = displayPath(root, absolute);

    const info = await stat(absolute).catch(() => undefined);
    if (info === undefined) throw new Error(`${shown} does not exist.`);
    if (info.isDirectory()) throw new Error(`${shown} is a folder. Use glob to list its files.`);
    if (info.size > LIMITS.readFileBytes) {
      throw new Error(
        `${shown} is ${info.size} bytes. The limit is ${LIMITS.readFileBytes} bytes.`,
      );
    }

    const buffer = await readFile(absolute);
    if (looksBinary(buffer)) throw new Error(`${shown} is a binary file.`);
    // edit_file needs this record (F11). A partial read still counts: the edit checks the whole file.
    files.record(absolute, buffer);

    const lines = splitLines(buffer.toString("utf8"));
    if (buffer.length === 0) return `${shown} is empty.`;
    if (offset > lines.length) {
      throw new Error(`${shown} has ${lines.length} lines. Offset ${offset} is past the end.`);
    }

    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((line, i) => `${String(offset + i).padStart(6)}\t${cutLine(line)}`);
    const { text, omitted } = joinWithinLimit(numbered);

    const last = offset + slice.length - omitted - 1;
    const more = last < lines.length;
    if (!more) return text;
    return `${text}\n\n[Lines ${offset}–${last} of ${lines.length}. Use offset ${last + 1} to read more.]`;
  },
};
