import { expect, it } from "vitest";
import { buildSystemPrompt, WORK_IN_FEW_STEPS } from "../src/context/instructions.js";

/**
 * The base prompt's rules for work in few steps (0.17): from `garuda eval tune`'s first kept
 * version (held-out cost per accepted change ×0.81 with Haiku 5.5, ×0.87 with Sonnet 5.5).
 */

it("every prompt has the rules, before the rule on remember", () => {
  const prompt = buildSystemPrompt("/p", undefined);
  const at = prompt.indexOf(WORK_IN_FEW_STEPS[0] ?? "x");
  expect(at).toBeGreaterThan(-1);
  for (const line of WORK_IN_FEW_STEPS) expect(prompt).toContain(line);
  expect(at).toBeLessThan(prompt.indexOf("save it with remember"));
});

it("the eval-only rules stay out: remember still works, and answers are not cut to a sentence", () => {
  const text = WORK_IN_FEW_STEPS.join("\n");
  expect(text).not.toMatch(/remember/i);
  expect(text).not.toMatch(/sentence/i);
  expect(buildSystemPrompt("/p", undefined)).toContain("save it with remember");
});

it("the rules never tell the agent to skip or weaken tests", () => {
  const text = WORK_IN_FEW_STEPS.join("\n");
  expect(text).toContain("Fix the code, not the tests.");
  expect(text).not.toMatch(/\b(skip|disable|weaken)\b[^.\n]{0,40}\btests?\b/i);
});
