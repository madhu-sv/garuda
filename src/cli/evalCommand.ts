import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatReport, runEvals } from "../evals/runner.js";
import { ALL_TASKS, EVAL_SUITES } from "../evals/suites.js";
import { newSessionId } from "../session/store.js";

export interface EvalCommandOptions {
  model?: string;
  task?: string[];
  maxSteps?: number;
  keep?: boolean;
  list?: boolean;
  suite?: string;
}

/** `garuda eval` (N5). Results go to .garuda/evals/<run-id>/ in the current folder. */
export async function runEvalCommand(options: EvalCommandOptions): Promise<number> {
  if (options.list) {
    for (const [suite, tasks] of Object.entries(EVAL_SUITES)) {
      process.stdout.write(`${suite}:\n`);
      for (const task of tasks) process.stdout.write(`  ${task.id.padEnd(18)} ${task.title}\n`);
    }
    return 0;
  }
  const modelId = options.model;
  if (!modelId) {
    process.stderr.write("Set a model with --model <id> or the GARUDA_MODEL variable.\n");
    return 1;
  }
  const suite = options.suite ?? "basic";
  const suiteTasks = suite === "all" ? ALL_TASKS : EVAL_SUITES[suite];
  if (suiteTasks === undefined) {
    process.stderr.write(
      `Unknown suite ${suite}. Use: ${[...Object.keys(EVAL_SUITES), "all"].join(", ")}.\n`,
    );
    return 1;
  }
  const tasks =
    options.task === undefined ? suiteTasks : ALL_TASKS.filter((t) => options.task?.includes(t.id));
  if (tasks.length === 0) {
    process.stderr.write("No task matches. Use --list to see the task ids.\n");
    return 1;
  }

  const outDir = join(process.cwd(), ".garuda", "evals", newSessionId());
  mkdirSync(outDir, { recursive: true });
  process.stderr.write(
    `Running ${tasks.length} task(s) (suite ${options.task === undefined ? suite : "custom"}) with ${modelId}. Garuda approves every call except its deny rules;\ncommands run on this machine in scratch folders.\n\n`,
  );

  const { AnthropicClient } = await import("../model/anthropic.js");
  const results = await runEvals(
    tasks,
    {
      modelId,
      model: () => new AnthropicClient({ model: modelId }),
      outDir,
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.keep ? { keep: true } : {}),
      onEvent: (taskId, event) => {
        if (event.type === "tool_call") process.stderr.write(`  [${taskId}] ${event.call.name}\n`);
      },
    },
    (r) =>
      process.stderr.write(
        `${r.passed ? "✓" : "✗"} ${r.id}: ${r.passed ? "pass" : "fail"} (${r.steps} steps)${r.reason ? `\n    ${r.reason.split("\n").slice(0, 3).join("\n    ")}` : ""}\n`,
      ),
  );

  const report = formatReport(results);
  writeFileSync(
    join(outDir, "report.json"),
    `${JSON.stringify({ model: modelId, suite, results }, null, 2)}\n`,
  );
  process.stdout.write(`\n${report}\n\nSession files and report.json: ${outDir}\n`);
  return results.every((r) => r.passed) ? 0 : 2;
}
