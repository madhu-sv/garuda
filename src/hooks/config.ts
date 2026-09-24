import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseRule, type Rule } from "../permissions/rules.js";

/**
 * Hooks (0.2): the user's own commands that run before or after tool calls.
 *   ~/.garuda/hooks.json         the user's hooks: trusted
 *   <root>/.garuda/hooks.json    project hooks: code from the repository, so the user sees every
 *                                command and agrees once; the answer is pinned to a hash
 *
 * {
 *   "hooks": {
 *     "preToolUse":  [{ "tools": ["bash(git push*)"], "command": "echo 'no pushes' >&2; exit 2" }],
 *     "postToolUse": [{ "tools": ["edit_file", "write_file"], "command": "prettier --write \"$GARUDA_FILE\"" }]
 *   }
 * }
 *
 * `tools` uses the permission rule syntax; empty means every tool.
 */

export const HOOKS_FILE = join(".garuda", "hooks.json");
export const HOOK_EVENTS = ["preToolUse", "postToolUse"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const hookSchema = z.strictObject({
  command: z.string().min(1),
  tools: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
  /** Network inside the sandbox. Default: none. */
  network: z.boolean().default(false),
});
const fileSchema = z.strictObject({
  hooks: z
    .strictObject({
      preToolUse: z.array(hookSchema).default([]),
      postToolUse: z.array(hookSchema).default([]),
    })
    .default({ preToolUse: [], postToolUse: [] }),
});

export type HookDef = z.infer<typeof hookSchema>;

export interface Hook {
  event: HookEvent;
  source: "user" | "project";
  def: HookDef;
  rules: Rule[];
}

/** Read one hooks file. A missing file gives no hooks. */
export async function readHooks(
  file: string,
  source: Hook["source"],
): Promise<{ hooks: Hook[]; problems: string[] }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hooks: [], problems: [] };
    return { hooks: [], problems: [`${file}: ${(error as Error).message}`] };
  }
  let parsed: z.infer<typeof fileSchema>;
  try {
    const result = fileSchema.safeParse(JSON.parse(text));
    if (!result.success)
      return { hooks: [], problems: [`${file}: ${z.prettifyError(result.error)}`] };
    parsed = result.data;
  } catch (error) {
    return { hooks: [], problems: [`${file}: invalid JSON: ${(error as Error).message}`] };
  }
  const hooks: Hook[] = [];
  const problems: string[] = [];
  for (const event of HOOK_EVENTS) {
    for (const def of parsed.hooks[event]) {
      try {
        hooks.push({ event, source, def, rules: def.tools.map(parseRule) });
      } catch (error) {
        problems.push(`${file}: ${(error as Error).message}`);
      }
    }
  }
  return { hooks, problems };
}

export async function loadHooks(home: string, root: string) {
  const user = await readHooks(join(home, HOOKS_FILE), "user");
  const project =
    home === root
      ? { hooks: [], problems: [] }
      : await readHooks(join(root, HOOKS_FILE), "project");
  return {
    user: user.hooks,
    project: project.hooks,
    problems: [...user.problems, ...project.problems],
  };
}

/** A hash of the project hooks. Consent is pinned to it. */
export function hooksHash(hooks: readonly Hook[]): string {
  const canonical = hooks.map((h) => ({ event: h.event, ...h.def }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
