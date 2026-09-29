import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nightCommand } from "../src/cli/nightCommand.js";
import { type Job, loadJob, saveJob } from "../src/jobs/job.js";
import { nightDigest, nightQueue, processRunner, runQueue } from "../src/jobs/night.js";
import { HostExecutor } from "../src/sandbox/host.js";

/** The night shift (0.11, W1). */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-night-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const lines: string[] = [];
const renderer = {
  event: () => {},
  info: (t: string) => lines.push(t),
  warn: (t: string) => lines.push(t),
  error: (t: string) => lines.push(t),
};

function job(root: string, id: string, extra: Partial<Job> = {}): Job {
  return {
    version: 1,
    id,
    title: `Task ${id}`,
    createdAt: `2026-09-29T20:0${id.slice(-1)}:00.000Z`,
    root,
    base: "a".repeat(40),
    branch: `garuda/job-${id}`,
    worktree: join(root, "wt", id),
    prompt: "do it",
    allow: [],
    onUnapproved: "deny-and-continue",
    maxSteps: 10,
    links: [],
    status: "scheduled",
    queue: true,
    ...extra,
  };
}

async function project(jobs: (root: string) => Job[]): Promise<string> {
  const root = join(base, `p${n++}`);
  mkdirSync(root, { recursive: true });
  for (const j of jobs(root)) await saveJob(j);
  return root;
}

describe("the night shift (0.11)", () => {
  it("queues scheduled jobs in the queue, oldest first; not done ones, not ones with their own agent", async () => {
    const root = await project((r) => [
      job(r, "j3"),
      job(r, "j1"),
      job(r, "j2", { status: "done" }),
      job(r, "j4", { queue: false }),
      job(r, "j5", { launchd: { label: "x", plist: "y", when: "z" } }),
    ]);
    expect((await nightQueue(root)).map((j) => j.id)).toEqual(["j1", "j3"]);
  });

  it("runs up to `parallel` jobs at a time, in queue order; a runner that throws does not stop the rest", async () => {
    const root = join(base, "unused");
    const jobs = ["a1", "a2", "a3", "a4", "a5"].map((id) => job(root, id));
    let running = 0;
    let most = 0;
    const started: string[] = [];
    const ended: string[] = [];
    await runQueue(
      jobs,
      async (j) => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
        if (j.id === "a2") throw new Error("boom");
        return 0;
      },
      2,
      { onStart: (j) => started.push(j.id), onEnd: (j, code) => ended.push(`${j.id}:${code}`) },
    );
    expect(most).toBe(2);
    expect(started).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect(ended).toContain("a2:null");
    expect(ended).toHaveLength(5);
  });

  it("the digest: one row per job, what needs a look and why", () => {
    const root = join(base, "d");
    const proof = (verdict: "ready" | "needs-look") => ({
      verdict,
      after: { exitCode: verdict === "ready" ? 0 : 1, timedOut: false, durationMs: 3000, tail: "" },
      flags:
        verdict === "ready"
          ? []
          : [{ level: "stop" as const, text: "The tests fail after the job." }],
      review: { verdict, text: "VERDICT: x\nSUMMARY: A clean change.", costUsd: 0.01 },
    });
    const result = (verdict: "ready" | "needs-look") => ({
      stopReason: "done",
      steps: 5,
      tokens: 1000,
      costUsd: 0.05,
      durationMs: 1000,
      files: [{ status: "modified" as const, path: "a.ts", added: 1, removed: 1 }],
      denied: [],
      answer: "",
      proof: proof(verdict),
    });
    const text = nightDigest(
      [
        job(root, "b1", { status: "done", test: "npm test", result: result("ready") }),
        job(root, "b2", { status: "done", test: "npm test", result: result("needs-look") }),
      ],
      new Date(2026, 8, 30, 1, 0),
      new Date(2026, 8, 30, 2, 30),
    );
    expect(text).toContain("# Garuda night shift: 2026-09-30 01:00");
    expect(text).toContain(
      "2 job(s): 1 ready to merge, 1 need a look. Time 90 min · cost $0.1200.",
    );
    expect(text).toContain(
      "| b1: Task b1 | ready to merge | pass in 3 s | 1 | $0.0600 | garuda/job-b1 |",
    );
    expect(text).toContain("- b2: The tests fail after the job. Review: A clean change.");
  });

  it("garuda night: runs the queue, reloads the jobs, writes the digest; an empty queue and a bad --parallel", async () => {
    const root = await project((r) => [job(r, "c1"), job(r, "c2")]);
    const ran: string[] = [];
    const code = await nightCommand(
      { parallel: "2" },
      renderer,
      async (j) => {
        ran.push(j.id);
        await saveJob({ ...j, status: "done" });
        return 0;
      },
      root,
    );
    expect(code).toBe(0);
    expect(ran.sort()).toEqual(["c1", "c2"]);
    expect((await loadJob(root, "c1")).status).toBe("done");
    const digest = lines.find((l) => l.includes("Digest: "));
    expect(digest).toMatch(/night-\d{8}-\d{4}\.md$/);
    const file = (digest ?? "").split("Digest: ")[1] as string;
    expect(readFileSync(file, "utf8")).toContain("2 job(s): 0 ready to merge, 2 need a look.");

    lines.length = 0;
    expect(await nightCommand({}, renderer, async () => 0, root)).toBe(0);
    expect(lines.at(-1)).toMatch(/^The night queue is empty\./);
    expect(await nightCommand({ parallel: "11" }, renderer, async () => 0, root)).toBe(1);
    expect(await nightCommand({ at: "25:00" }, renderer, async () => 0, root)).toBe(1);
  });

  it("the process runner: garuda run <id> in the project, with this process's environment, output in the log", async () => {
    const root = await project((r) => [job(r, "e1")]);
    const script = join(base, "fake-garuda.mjs");
    writeFileSync(
      script,
      'console.log(`args=${process.argv.slice(2).join(" ")} cwd=${process.cwd()} mark=${process.env.GARUDA_NIGHT_MARK}`);\n',
    );
    process.env.GARUDA_NIGHT_MARK = "kept";
    const run = processRunner(new HostExecutor(), {
      home: base,
      uid: 0,
      shell: "/bin/sh",
      node: process.execPath,
      script,
    });
    expect(await run(await loadJob(root, "e1"))).toBe(0);
    delete process.env.GARUDA_NIGHT_MARK;
    const log = readFileSync(join(root, ".garuda/jobs/e1.log"), "utf8");
    expect(log).toBe(`args=run e1 cwd=${root} mark=kept\n`);
  });
});
