import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectStack, firstRunTour, tourChoice, tourPrompts } from "../src/cli/tour.js";
import { countChat } from "../src/cli/uiState.js";
import { BRIEF_FILE, briefText, endedSince, morningBrief, testsText } from "../src/jobs/brief.js";
import type { Job } from "../src/jobs/job.js";

/** UX U7 and U9 (docs/lld/ux.md): the morning brief and the first-run tour. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-brief-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const folder = (name: string) => {
  const dir = join(base, `${name}-${++n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const plain = (_style: string, text: string) => text;
const NOW = Date.parse("2026-11-06T08:00:00Z");

function job(root: string, id: string, over: Partial<Job> = {}): Job {
  return {
    version: 1,
    id,
    title: `Job ${id}`,
    createdAt: "2026-11-05T20:00:00Z",
    root,
    base: "a".repeat(40),
    branch: `garuda/job-${id}`,
    worktree: join(root, ".garuda", "worktrees", id),
    prompt: "do it",
    allow: [],
    onUnapproved: "deny-and-continue",
    maxSteps: 100,
    links: [],
    status: "done",
    endedAt: "2026-11-06T02:00:00Z",
    result: {
      stopReason: "done",
      steps: 5,
      tokens: 1000,
      costUsd: 0.1,
      durationMs: 1000,
      files: [],
      denied: [],
      answer: "ok",
      proof: {
        verdict: "ready",
        before: { exitCode: 0, timedOut: false, durationMs: 1, tail: "# tests 120\n# fail 0" },
        after: { exitCode: 0, timedOut: false, durationMs: 1, tail: "# tests 126\n# fail 0" },
        flags: [],
      },
    },
    ...over,
  } as Job;
}

describe("the morning brief", () => {
  it("names each job's verdict, tests and branch, and the total cost", () => {
    const root = "/r";
    const failed = job(root, "b", {
      title: "Upgrade undici",
      result: {
        ...(job(root, "x").result as NonNullable<Job["result"]>),
        costUsd: 0.11,
        proof: {
          verdict: "needs-look",
          after: { exitCode: 1, timedOut: false, durationMs: 1, tail: "3 failed" },
          flags: [],
        },
      },
    });
    const text = briefText([job(root, "a", { title: "Add CSV export" }), failed], plain) ?? "";
    const lines = text.split("\n");
    expect(lines[0]).toBe("While you were away: 2 jobs ran ($0.2100)");
    expect(lines[1]).toMatch(
      /^ {2}✓ Add CSV export +ready to merge +tests 120 → 126 +garuda\/job-a$/,
    );
    expect(lines[2]).toMatch(
      /^ {2}✗ Upgrade undici +needs a look +tests fail after the change +garuda\/job-b$/,
    );
    expect(lines[3]).toContain("/jobs <id>");
    expect(briefText([], plain)).toBeUndefined();
    expect(
      testsText(
        job(root, "c", {
          result: { ...(job(root, "c").result as NonNullable<Job["result"]>), proof: undefined },
        }),
      ),
    ).toBe("no tests");
  });

  it("takes only jobs that ended after the last brief, oldest first", () => {
    const jobs = [
      job("/r", "late", { endedAt: "2026-11-06T03:00:00Z" }),
      job("/r", "early", { endedAt: "2026-11-06T01:00:00Z" }),
      job("/r", "old", { endedAt: "2026-11-04T01:00:00Z" }),
      job("/r", "waiting", { status: "scheduled", endedAt: undefined } as Partial<Job>),
    ];
    expect(endedSince(jobs, Date.parse("2026-11-05T00:00:00Z")).map((j) => j.id)).toEqual([
      "early",
      "late",
    ]);
  });

  it("shows once: the next chat start shows nothing until a new job ends", async () => {
    const root = folder("p");
    mkdirSync(join(root, ".garuda", "jobs"), { recursive: true });
    for (const j of [job(root, "a"), job(root, "old", { endedAt: "2026-11-01T00:00:00Z" })]) {
      writeFileSync(join(root, ".garuda", "jobs", `${j.id}.json`), JSON.stringify(j));
    }
    const first = await morningBrief(root, plain, NOW);
    // The first brief covers the last day: the job of 1 November is not in it.
    expect(first?.split("\n")[0]).toBe("While you were away: 1 job ran ($0.1000)");
    expect(JSON.parse(readFileSync(join(root, ".garuda", "jobs", BRIEF_FILE), "utf8"))).toEqual({
      seenAt: new Date(NOW).toISOString(),
    });
    expect(await morningBrief(root, plain, NOW + 60_000)).toBeUndefined();
    const later = job(root, "b", { endedAt: new Date(NOW + 3_600_000).toISOString() });
    writeFileSync(join(root, ".garuda", "jobs", "b.json"), JSON.stringify(later));
    expect((await morningBrief(root, plain, NOW + 7_200_000))?.split("\n")[0]).toBe(
      "While you were away: 1 job ran ($0.1000)",
    );
  });
});

describe("the first-run tour", () => {
  const project = (files: Record<string, string>) => {
    const root = folder("code");
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    return root;
  };

  it("names the stack from the project's files", () => {
    const ts = project({
      "package.json": JSON.stringify({
        scripts: { test: "vitest run" },
        devDependencies: { vitest: "1" },
      }),
      "tsconfig.json": "{}",
      "pnpm-lock.yaml": "",
    });
    expect(detectStack(ts, [])).toEqual({
      label: "TypeScript with vitest (pnpm)",
      test: "pnpm test",
    });
    const rn = project({
      "package.json": JSON.stringify({ dependencies: { "react-native": "0" } }),
    });
    expect(detectStack(rn, [])?.label).toBe("JavaScript (React Native) (npm)");
    expect(detectStack(project({ "go.mod": "module x" }), [])?.label).toBe("Go");
    expect(detectStack(folder("empty"), [])).toBeUndefined();
  });

  it("offers three tasks; the test task names the project's command", () => {
    expect(tourPrompts({ label: "x", test: "pnpm test" })[1]).toBe(
      "Run the tests (pnpm test) and explain any failure.",
    );
    expect(tourPrompts({ label: "x" })[1]).toMatch(/riskiest function/);
  });

  it("shows once per project, and the chat count keeps the list", async () => {
    const home = folder("home");
    const root = project({ "package.json": "{}" });
    const first = await firstRunTour(root, home, []);
    expect(first?.text.split("\n")[0]).toBe("This looks like JavaScript (npm). Some first tasks:");
    // The negative control for the shared file: counting a chat must not drop the tour list.
    await countChat(home);
    expect(await firstRunTour(root, home, [])).toBeUndefined();
    expect(await firstRunTour(project({ "package.json": "{}" }), home, [])).toBeDefined();
    expect(await firstRunTour(folder("notes"), home, [])).toBeUndefined();
    expect(readFileSync(join(home, ".garuda", "ui.json"), "utf8")).not.toContain(root);
  });

  it("the first input 1, 2 or 3 becomes that task; anything else stays", () => {
    const tasks = ["one", "two", "three"];
    expect(tourChoice("2", tasks)).toBe("two");
    expect(tourChoice(" 3 ", tasks)).toBe("three");
    expect(tourChoice("4", tasks)).toBe("4");
    expect(tourChoice("fix the bug", tasks)).toBe("fix the bug");
    expect(tourChoice("2", undefined)).toBe("2");
  });
});
