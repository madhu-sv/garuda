import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { cleanText, neutralizeTags } from "../mcp/sanitize.js";
import type { ApprovalRequest } from "../permissions/types.js";
import { parseFrontmatterBlock } from "./frontmatter.js";

/**
 * Skills (0.5): folders with a SKILL.md, in the Agent Skills format that Claude Code uses
 * (https://agentskills.io/specification). Garuda reads them where they are:
 *
 *   ~/.garuda/skills/<name>/SKILL.md   user skills (trusted)
 *   ~/.claude/skills/<name>/SKILL.md   user skills of Claude Code (trusted)
 *   <root>/.garuda/skills/<name>/      project skills (ask at first use)
 *   <root>/.claude/skills/<name>/      project skills of Claude Code (ask at first use)
 *
 * On a name clash the first one in this list wins: user skills win over project skills, as in
 * Claude Code, so a repository cannot replace a skill that the user trusts.
 *
 * Only the name and the description go to the model at the start (in the skill tool's
 * description). The body loads when the model calls the skill tool, or when the user types
 * /name. A skill is only text: the tool calls it leads to still ask or run in the sandbox.
 */

export type SkillSource = "user" | "project";

export interface Skill {
  name: string;
  source: SkillSource;
  /** Absolute path of the skill folder. */
  dir: string;
  /** The folder as the user sees it: ~/.garuda/skills/x or .claude/skills/x. */
  shown: string;
  /** What it does and when to use it (with `when_to_use`), for the model's list. */
  description: string;
  argumentHint?: string;
  /** false: only the user can run it (`disable-model-invocation: true`). */
  modelInvocable: boolean;
  /** false: only the model can load it (`user-invocable: false`). */
  userInvocable: boolean;
  /** The instructions after the frontmatter. */
  body: string;
  /** SHA-256 of SKILL.md, for the trust store. */
  hash: string;
}

export interface LoadedSkills {
  skills: Skill[];
  /** Folders that were skipped, and why. */
  problems: string[];
}

export const SKILL_FILE = "SKILL.md";
/** The Agent Skills name rule: a–z, 0–9 and single hyphens, up to 64 characters. */
export const SKILL_NAME = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;
/** Larger files are refused: the spec asks for less than 5 000 tokens. */
export const SKILL_MAX_CHARS = 50_000;
/** Claude Code cuts the listing of one skill at 1 536 characters. */
export const DESCRIPTION_MAX_CHARS = 1_536;
const MAX_SKILLS = 100;

export function skillDirs(home: string, root: string) {
  return [
    { dir: join(home, ".garuda", "skills"), shown: "~/.garuda/skills", source: "user" as const },
    { dir: join(home, ".claude", "skills"), shown: "~/.claude/skills", source: "user" as const },
    { dir: join(root, ".garuda", "skills"), shown: ".garuda/skills", source: "project" as const },
    { dir: join(root, ".claude", "skills"), shown: ".claude/skills", source: "project" as const },
  ];
}

export async function loadSkills(options: {
  home: string;
  root: string;
  /** Names of built-in chat commands: a skill cannot use them. */
  builtins: readonly string[];
}): Promise<LoadedSkills> {
  const problems: string[] = [];
  const byName = new Map<string, Skill>();
  const seen = new Set<string>();
  for (const place of skillDirs(options.home, options.root)) {
    // When the root is the home folder, the project folders are the user folders.
    if (seen.has(place.dir)) continue;
    seen.add(place.dir);
    for (const skill of await loadDir(place, problems)) {
      if (options.builtins.includes(skill.name)) {
        problems.push(
          `${skill.shown}: /${skill.name} is a built-in command; this skill is ignored.`,
        );
      } else if (byName.has(skill.name)) {
        const first = byName.get(skill.name) as Skill;
        problems.push(
          `${skill.shown}: a skill named "${skill.name}" is already in ${first.shown}; that one wins.`,
        );
      } else if (byName.size >= MAX_SKILLS) {
        problems.push(`${skill.shown}: more than ${MAX_SKILLS} skills; ignored.`);
      } else {
        byName.set(skill.name, skill);
      }
    }
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, problems };
}

async function loadDir(
  place: { dir: string; shown: string; source: SkillSource },
  problems: string[],
): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = (await readdir(place.dir)).sort();
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const dir = join(place.dir, entry);
    const shown = `${place.shown}/${entry}`;
    const file = join(dir, SKILL_FILE);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      // A project skill may not be a link: it could show a file from outside the repository.
      if (
        place.source === "project" &&
        ((await lstat(dir)).isSymbolicLink() || (await lstat(file)).isSymbolicLink())
      ) {
        problems.push(`${shown}: a project skill may not be a symbolic link; ignored.`);
        continue;
      }
      const text = await readFile(file, "utf8");
      if (text.length > SKILL_MAX_CHARS) {
        problems.push(
          `${shown}/${SKILL_FILE}: longer than ${SKILL_MAX_CHARS} characters; ignored.`,
        );
        continue;
      }
      const skill = parseSkill(text, { entry, dir, shown, source: place.source });
      if (typeof skill === "string") problems.push(`${shown}/${SKILL_FILE}: ${skill}`);
      else out.push(skill);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      problems.push(`${shown}: ${(error as Error).message}`);
    }
  }
  return out;
}

/** A skill from the text of SKILL.md, or the reason it is not valid. */
export function parseSkill(
  text: string,
  place: { entry: string; dir: string; shown: string; source: SkillSource },
): Skill | string {
  const { meta, body: raw } = parseFrontmatterBlock(text);
  const name = meta.name ?? place.entry;
  if (!SKILL_NAME.test(name)) {
    return `the name "${name}" is not valid. Use a–z, 0–9 and single hyphens (up to 64).`;
  }
  const clean = cleanText(raw).trim();
  const body = place.source === "project" ? neutralizeTags(clean) : clean;
  if (body === "") return "the skill has no instructions; ignored.";
  // Claude Code takes the first line of the body when there is no description.
  const first = body.split("\n").find((l) => l.trim() !== "" && !l.startsWith("#"));
  const description = [meta.description ?? first ?? "", meta.when_to_use ?? ""]
    // A project skill's description reaches the model before any consent: no Garuda markers in it
    // (0.14.1, review), as in its body.
    .map((s) => cleanText(s).replace(/\s+/g, " ").trim())
    .map((s) => (place.source === "project" ? neutralizeTags(s) : s))
    .filter((s) => s !== "")
    .join(" ")
    .slice(0, DESCRIPTION_MAX_CHARS);
  if (description === "") return "the skill has no description; ignored.";
  const hint = meta["argument-hint"];
  return {
    name,
    source: place.source,
    dir: place.dir,
    shown: place.shown,
    description,
    ...(hint === undefined
      ? {}
      : {
          argumentHint:
            place.source === "project" ? neutralizeTags(cleanText(hint)) : cleanText(hint),
        }),
    modelInvocable: !isTrue(meta["disable-model-invocation"]),
    userInvocable: !isFalse(meta["user-invocable"]),
    body,
    hash: createHash("sha256").update(text).digest("hex"),
  };
}

const TRUE = new Set(["true", "yes", "on", "1"]);
const FALSE = new Set(["false", "no", "off", "0"]);
export const isTrue = (v: string | undefined) => v !== undefined && TRUE.has(v.toLowerCase());
export const isFalse = (v: string | undefined) => v !== undefined && FALSE.has(v.toLowerCase());

/**
 * The text a skill gives: its body with arguments. As in Claude Code, `$ARGUMENTS` takes all
 * arguments, `$ARGUMENTS[N]` and `$N` take one (from 0), and `${CLAUDE_SKILL_DIR}` or
 * `${GARUDA_SKILL_DIR}` is the skill folder. With no placeholder, the arguments go after the text.
 */
export function expandSkill(skill: Skill, args: string, folder: string): string {
  const words = [...args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? "",
  );
  const hasPlaceholder = /\$ARGUMENTS|\$\d/.test(skill.body);
  // One pass over the body (0.14.1, review): text that an argument inserts is never read again, so
  // "$5" or "$&" in the arguments stays as typed. "\$1.00" in prose stays "$1.00".
  const text = skill.body.replace(
    /\$\{(?:CLAUDE|GARUDA)_SKILL_DIR\}|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\\\$(\d)|\$(\d)/g,
    (all, index?: string, escaped?: string, n?: string) => {
      if (all.startsWith("${")) return folder;
      if (index !== undefined) return words[Number(index)] ?? "";
      if (all === "$ARGUMENTS") return args;
      if (escaped !== undefined) return `$${escaped}`;
      return words[Number(n)] ?? "";
    },
  );
  return hasPlaceholder || args === "" ? text : `${text}\n\nARGUMENTS: ${args}`;
}

/** The consent question for a project skill, with its full instructions. */
export function skillConsent(
  skill: Skill,
  changed: boolean,
  isolation: ApprovalRequest["isolation"],
): ApprovalRequest {
  const lines = [
    changed
      ? `The project skill "${skill.name}" changed since you allowed it (${skill.shown}/${SKILL_FILE}).`
      : `"${skill.name}" is a project skill from ${skill.shown}/${SKILL_FILE}.`,
    "It gives the model these instructions:",
    "",
    ...skill.body.split("\n").map((line) => `  │ ${line}`),
    "",
    "Tool calls that it leads to still ask or run in the sandbox, as usual.",
    "Allow it only if you trust this project.",
  ];
  return {
    tool: "skill",
    target: { kind: "input", json: JSON.stringify({ skill: skill.name, folder: skill.shown }) },
    preview: lines.join("\n"),
    isolation,
    title: `Use the project skill "${skill.name}"?`,
    labels: {
      once: "Yes, for this session only",
      session: "Yes, and remember (asks again if SKILL.md changes)",
      deny: "No",
    },
  };
}

/** Kept for the tests and callers of 0.5: the shared reader (frontmatter.ts). */
export { parseFrontmatterBlock as parseSkillFrontmatter } from "./frontmatter.js";
