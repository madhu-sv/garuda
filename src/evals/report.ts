import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../jobs/git.js";
import { HostExecutor } from "../sandbox/host.js";
import { VERSION } from "../version.js";
import {
  byTask,
  consistency,
  costPerPass,
  passInterval,
  spread,
  stepsSd,
  unexpectedChanges,
} from "./stats.js";
import type { EvalResult, EvalTask } from "./types.js";

/**
 * report.json, version 2 (0.17, T11a; docs/lld/eval-evidence.md): the run's metadata, a hash of
 * each task, and the evidence (interval, consistency, spread, cost per accepted change,
 * unexpected changes). Version 1 had no `schema` field.
 */
export const REPORT_SCHEMA = 2;

/**
 * A hash of what decides a task's result: its prompt, files, check, protected files, solution,
 * allowed changes and, for a repo task, its commit and tests. Keys are sorted, so the same task
 * always gives the same hash. A later report shows with it that the tasks did not change.
 */
export function taskHash(task: EvalTask): string {
  const sorted = (record: Record<string, string>) =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const data = {
    prompt: task.prompt,
    files: sorted(task.files),
    check: task.check,
    protect: task.protect ?? null,
    solution: sorted(task.solution),
    allowChanges: task.allowChanges ?? null,
    repo:
      task.repo === undefined
        ? null
        : { base: task.repo.base, sha: task.repo.sha ?? null, tests: task.repo.tests },
  };
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

/** Garuda's git commit when it runs from a checkout; undefined from the npm package. */
export async function garudaCommit(): Promise<string | undefined> {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, ".git"))) {
      const r = await git(new HostExecutor(), dir, ["rev-parse", "HEAD"], { check: false });
      return r.exitCode === 0 ? r.stdout.trim() : undefined;
    }
    dir = dirname(dir);
  }
  return undefined;
}

export interface ReportMetadata {
  model: string;
  provider: string;
  executor: string;
  isolation: string;
  seed: number;
  shuffle: boolean;
}

/** The version 2 fields: metadata, task hashes, the run order and the evidence. */
export async function reportV2(
  meta: ReportMetadata,
  tasks: readonly EvalTask[],
  results: readonly EvalResult[],
): Promise<Record<string, unknown>> {
  const commit = await garudaCommit();
  return {
    schema: REPORT_SCHEMA,
    garuda: { version: VERSION, ...(commit === undefined ? {} : { commit }) },
    spec: meta.model,
    provider: meta.provider,
    // Evals set no effort: each model's default applies.
    effort: "model default",
    isolation: meta.isolation,
    os: { platform: platform(), release: release(), arch: arch(), node: process.versions.node },
    seed: meta.seed,
    shuffle: meta.shuffle,
    order: results.map((r) => ({ id: r.id, attempt: r.attempt ?? 1 })),
    tasks: Object.fromEntries(tasks.map((t) => [t.id, taskHash(t)])),
    evidence: {
      interval: passInterval(results, { seed: meta.seed }) ?? null,
      consistency: consistency(results),
      spread: spread(results) ?? null,
      stepsSd: Object.fromEntries(byTask(results).map((t) => [t.id, stepsSd(t.results) ?? null])),
      costPerAcceptedChange: costPerPass(results),
      unexpected: unexpectedChanges(results),
    },
  };
}
