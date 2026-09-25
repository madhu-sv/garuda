import { describe, expect, it } from "vitest";
import { JAVA_TASKS } from "../src/evals/javaTasks.js";
import { isProtectedPath } from "../src/evals/projects.js";
import { checkToolchains, TOOLCHAINS } from "../src/evals/toolchains.js";
import { expectFailsThenPasses } from "./evalTasks.js";

// The self-tests need the toolchain. Without it they are skipped, and the name says how to fix it.
const [status] = await checkToolchains(["maven"]);
const ready = status?.ok === true;
const skipNote = ready ? "" : ` (skipped: ${TOOLCHAINS.maven.hint})`;

describe("java eval suite (0.3)", () => {
  it("has 5 tasks with unique ids that need the maven toolchain", () => {
    expect(JAVA_TASKS).toHaveLength(5);
    expect(new Set(JAVA_TASKS.map((t) => t.id)).size).toBe(5);
    for (const task of JAVA_TASKS) {
      expect(task.requires).toEqual(["maven"]);
      // Tests and build files are protected, so the agent cannot pass by changing them.
      const protectedFiles = task.protect ?? Object.keys(task.files).filter(isProtectedPath);
      expect(protectedFiles.some((p) => /test/i.test(p))).toBe(true);
    }
  });

  describe.concurrent("each task fails before the fix and passes with the solution", () => {
    for (const task of JAVA_TASKS) {
      it.skipIf(!ready)(`${task.id}${skipNote}`, () => expectFailsThenPasses(task), 180_000);
    }
  });
});
