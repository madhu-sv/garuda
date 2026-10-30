import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { runCheck, writeFiles } from "../src/evals/runner.js";
import { checkToolchains, TOOLCHAINS, type ToolchainId } from "../src/evals/toolchains.js";
import type { EvalTask } from "../src/evals/types.js";

/** Each task must fail as given and pass with its solution. Otherwise the eval measures nothing. */
export async function expectFailsThenPasses(task: EvalTask): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `garuda-task-${task.id}-`)));
  try {
    await writeFiles(root, task.files);
    expect((await runCheck(root, task.check)).ok, "the check must fail before the fix").toBe(false);
    await writeFiles(root, task.solution);
    const after = await runCheck(root, task.check);
    expect(after.ok, after.output).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Run a task's check after the agent wrote `files` on top of the task's own files. */
export async function checkWith(task: EvalTask, files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `garuda-task-${task.id}-`)));
  try {
    await writeFiles(root, task.files);
    await writeFiles(root, files);
    return await runCheck(root, task.check);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The task's solution with `edits` (old → new text) in one of its files. */
export function solutionWith(task: EvalTask, path: string, edits: [string, string][]) {
  let text = task.solution[path] ?? task.files[path];
  if (text === undefined) throw new Error(`${task.id}: no ${path}`);
  for (const [from, to] of edits) {
    if (!text.includes(from)) throw new Error(`${task.id}: ${path} has no ${from}`);
    text = text.replace(from, to);
  }
  return { ...task.solution, [path]: text };
}

/** Which toolchains work here; a task's self-test skips with the hint when one is missing. */
export async function toolchainReadiness() {
  const status = new Map(
    (await checkToolchains(["pytest", "maven"])).map((s) => [s.id, s.ok === true] as const),
  );
  const ready = (task: EvalTask) => (task.requires ?? []).every((id) => status.get(id) === true);
  const skipNote = (task: EvalTask) => {
    const missing = (task.requires ?? []).filter((id) => status.get(id) !== true);
    return missing.length === 0
      ? ""
      : ` (skipped: ${missing.map((id: ToolchainId) => TOOLCHAINS[id].hint).join("; ")})`;
  };
  return { status, ready, skipNote };
}
