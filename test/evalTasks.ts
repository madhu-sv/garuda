import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { runCheck, writeFiles } from "../src/evals/runner.js";
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
