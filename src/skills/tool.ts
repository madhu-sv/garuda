import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { cleanText, neutralizeTags } from "../mcp/sanitize.js";
import { isInside } from "../permissions/pathGuard.js";
import { looksBinary } from "../tools/limits.js";
import type { Tool } from "../tools/types.js";
import { expandSkill, SKILL_FILE, type Skill } from "./load.js";

/**
 * The skill tool (0.5). Its description lists the skills that the model may load (name and
 * description). The list is fixed when the session starts, so every request sends the same
 * tool bytes (N2). A call gives the skill's instructions, its folder and its files; a call with
 * `file` gives one file of the folder (references, templates). Scripts run with bash, as usual.
 */

export interface SkillToolOptions {
  skills: readonly Skill[];
  root: string;
  home: string;
  /** Asks for a project skill the first time. True when the user allows it. */
  allow(skill: Skill, signal: AbortSignal): Promise<boolean>;
}

const input = z.object({
  name: z.string().min(1).describe("The skill name from the list."),
  arguments: z
    .string()
    .optional()
    .describe("Text for the skill, for example what the user asked for. Optional."),
  file: z
    .string()
    .optional()
    .describe(
      "A file inside the skill folder to read instead, for example references/api.md. Optional.",
    ),
});

interface Output {
  text: string;
  error: boolean;
}

const MAX_FILES_LISTED = 50;
const FILE_MAX_CHARS = 100_000;

export function createSkillTool(options: SkillToolOptions): Tool<z.infer<typeof input>, Output> {
  const listed = options.skills.filter((s) => s.modelInvocable);
  return {
    name: "skill",
    description: [
      "Load a skill: instructions for one kind of task, written by the user or for this project.",
      "When the task matches a skill below, load it before you start the work, and follow it.",
      "The result gives the skill's folder and files. Read a file of the skill with `file`;",
      "run a script of the skill with bash, with the folder path that the result gives.",
      "",
      "Skills:",
      ...listed.map((s) => `- ${s.name}: ${s.description}`),
    ].join("\n"),
    inputSchema: input,
    readOnly: true,

    async run({ name, arguments: args = "", file }, { signal }) {
      const skill = listed.find((s) => s.name === name);
      if (skill === undefined) {
        return {
          error: true,
          text: `No skill named "${name}". Skills: ${listed.map((s) => s.name).join(", ")}.`,
        };
      }
      if (!(await options.allow(skill, signal))) {
        return {
          error: true,
          text: `The user did not allow the project skill "${name}". Do the task without it, or ask the user.`,
        };
      }
      if (file !== undefined) return readSkillFile(skill, file);
      return { error: false, text: await skillText(skill, args, options) };
    },

    toText: (output) => output.text,
    isError: (output) => output.error,
  };
}

/** The folder path for bash: relative to the root when it is inside, else absolute. */
export function skillFolder(skill: Skill, root: string): string {
  return isInside(root, skill.dir) ? relative(root, skill.dir).split(sep).join("/") : skill.dir;
}

/** The text of a loaded skill, for the tool result and for /name. */
export async function skillText(
  skill: Skill,
  args: string,
  place: { root: string },
): Promise<string> {
  const folder = skillFolder(skill, place.root);
  const files = await listFiles(skill.dir);
  const lines = [
    `<skill name="${skill.name}" folder="${folder}">`,
    expandSkill(skill, args, folder),
    "</skill>",
  ];
  if (files.length > 0) {
    const script = files.find((f) => f.startsWith("scripts/"));
    lines.push(
      `Files in the skill folder: ${files.join(", ")}${files.length >= MAX_FILES_LISTED ? ", …" : ""}.`,
      `Read one with skill(name: "${skill.name}", file: "<path>").${script === undefined ? "" : ` Run a script with bash, for example: ${folder}/${script}`}`,
    );
  }
  return lines.join("\n");
}

async function readSkillFile(skill: Skill, file: string): Promise<Output> {
  const target = resolve(skill.dir, file);
  try {
    // The file must stay inside the skill folder, also through links.
    const [realDir, realTarget] = await Promise.all([realpath(skill.dir), realpath(target)]);
    if (!isInside(realDir, realTarget) || !isInside(skill.dir, target)) {
      return { error: true, text: `"${file}" is outside the skill folder.` };
    }
    if (!(await stat(realTarget)).isFile()) {
      return { error: true, text: `"${file}" is not a file.` };
    }
    const buffer = await readFile(realTarget);
    if (looksBinary(buffer)) return { error: true, text: `"${file}" is a binary file.` };
    let text = cleanText(buffer.toString("utf8"));
    if (skill.source === "project") text = neutralizeTags(text);
    if (text.length > FILE_MAX_CHARS) {
      text = `${text.slice(0, FILE_MAX_CHARS)}\n[Garuda: the file is longer; the rest is cut.]`;
    }
    return {
      error: false,
      text: `<skill_file skill="${skill.name}" path="${file}">\n${text}\n</skill_file>`,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      error: true,
      text: code === "ENOENT" ? `No file "${file}" in the skill folder.` : (error as Error).message,
    };
  }
}

/** Files of a skill folder (not SKILL.md), up to three levels deep, sorted. */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, depth: number) => {
    let entries: string[];
    try {
      entries = (await readdir(current)).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= MAX_FILES_LISTED) return;
      if (name.startsWith(".")) continue;
      const full = join(current, name);
      const info = await stat(full).catch(() => undefined);
      if (info?.isDirectory()) {
        if (depth < 3) await walk(full, depth + 1);
      } else if (info?.isFile()) {
        const rel = relative(dir, full).split(sep).join("/");
        if (rel !== SKILL_FILE) out.push(rel);
      }
    }
  };
  await walk(dir, 1);
  return out;
}
