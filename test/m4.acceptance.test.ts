import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { replaySession } from "../src/loop/replay.js";
import { runAgent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { Usage } from "../src/model/types.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { HostExecutor } from "../src/sandbox/host.js";
import type { RunLimits } from "../src/session/records.js";
import { Redactor } from "../src/session/redact.js";
import { resumeSession } from "../src/session/resume.js";
import { addUserMessage, createSession } from "../src/session/session.js";
import { FileSessionStore, MemoryJournal } from "../src/session/store.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { allowAll, upperTool } from "./helpers.js";
import { makeSampleRepo } from "./sampleRepo.js";

const repo = makeSampleRepo();
afterAll(repo.cleanup);

const limits: RunLimits = { maxSteps: 50, tokenBudget: 20_000_000, contextWindow: 200_000 };
const startFields = {
  root: repo.root,
  version: "test",
  model: "fake",
  executor: "host",
  isolation: "none",
  limits,
};

function deps(model: FakeModelClient, approver = new AutoApprover("once")) {
  return {
    model,
    tools: new ToolRegistry(defaultTools()),
    system: "test",
    permissions: new PermissionEngine({ root: repo.root, approver }),
    ...limits,
  };
}

describe("M4 acceptance", () => {
  it("a 60-step task stops at 50 and says why", async () => {
    // Two patterns in turn, so the repeat guard (F7) does not stop the run first.
    const steps = Array.from({ length: 60 }, (_, i) =>
      reply([toolUse("glob", { pattern: i % 2 === 0 ? "**/*.ts" : "**/*.md" })]),
    );
    const model = new FakeModelClient(steps);
    const journal = new MemoryJournal();
    const session = createSession(repo.root, "s60", journal);
    addUserMessage(session, "Keep going forever.");

    const result = await runAgent(session, deps(model));

    expect(result).toMatchObject({ stopReason: "max_steps", steps: 50 });
    expect(model.requests).toHaveLength(50);
    expect(model.remaining).toBe(10);
    expect(journal.records.at(-1)).toMatchObject({
      type: "end",
      stopReason: "max_steps",
      steps: 50,
    });
  });

  it("--resume continues the last session, and a replay of it matches the recording", async () => {
    const store = new FileSessionStore(repo.root, new Redactor({}));

    // Process 1: one run that reads a file.
    const first = createSession(repo.root, "s-resume", store.open("s-resume"));
    first.journal?.write({ type: "start", sessionId: "s-resume", ...startFields });
    addUserMessage(first, "What does src/util/strings.ts export?");
    await runAgent(
      first,
      deps(
        new FakeModelClient([
          reply([toolUse("read_file", { path: "src/util/strings.ts" }, "r1")]),
          reply([text("It exports shout().")]),
        ]),
      ),
    );

    // Process 2: resume the latest session and continue.
    const session = await resumeSession({ store, root: repo.root, start: startFields });
    expect(session.id).toBe("s-resume");
    addUserMessage(session, "Rename shout to yell.");
    const model = new FakeModelClient([
      (request) => {
        // The model sees the first run in full.
        expect(request.messages).toHaveLength(5);
        expect(JSON.stringify(request.messages)).toContain("It exports shout().");
        return reply([
          toolUse(
            "edit_file",
            { path: "src/util/strings.ts", old_string: "shout", new_string: "yell" },
            "e1",
          ),
        ]);
      },
      (request) => {
        // Read tracking does not survive a resume: the agent must read again (F11).
        const result = request.messages.at(-1)?.content[0];
        expect(result).toMatchObject({ isError: true });
        expect(JSON.stringify(result)).toContain("before you edit it");
        return reply([
          toolUse("read_file", { path: "src/util/strings.ts" }, "r2"),
          toolUse("glob", { pattern: "src/**/*.ts" }, "g1"),
        ]);
      },
      reply([
        toolUse(
          "edit_file",
          { path: "src/util/strings.ts", old_string: "shout", new_string: "yell" },
          "e2",
        ),
      ]),
      reply([toolUse("bash", { command: "grep -c yell src/util/strings.ts" }, "b1")]),
      reply([text("Renamed.")]),
    ]);
    const approver = new AutoApprover("once");
    const result = await runAgent(session, {
      ...deps(model, approver),
      executor: new HostExecutor(),
    });
    expect(result).toMatchObject({ stopReason: "done", steps: 5 });
    expect(readFileSync(`${repo.root}/src/util/strings.ts`, "utf8")).toContain("yell");
    expect(approver.requests.map((r) => r.tool)).toEqual(["edit_file", "bash"]);

    // Replay: no model, no tools run, same calls and same conversation (F26).
    const records = await store.read("s-resume");
    expect(records.map((r) => r.type).filter((t) => t === "start" || t === "resume")).toEqual([
      "start",
      "resume",
    ]);
    const report = await replaySession(records, new ToolRegistry(defaultTools()));
    expect(report).toEqual({ matches: true, runs: 2, steps: 7, toolCalls: 6, problems: [] });

    // A broken record breaks the match: here, one run now claims a different stop.
    const changed = records.map((r) =>
      r.type === "end" && r.steps === 2 ? { ...r, stopReason: "max_steps" } : r,
    );
    const bad = await replaySession(changed, new ToolRegistry(defaultTools()));
    expect(bad.problems[0]).toMatch(/Run 1: the recording stopped with max_steps/);
    expect(bad.matches).toBe(false);
  });

  it("replay also matches a session with a compaction summary", async () => {
    const journal = new MemoryJournal();
    const session = createSession("/tmp/replay", "sc", journal);
    const small: RunLimits = { maxSteps: 50, tokenBudget: 20_000_000, contextWindow: 20_000 };
    journal.write({
      type: "start",
      sessionId: "sc",
      ...startFields,
      root: "/tmp/replay",
      limits: small,
    });
    addUserMessage(session, "Shout many things.");
    const heavy = (n: number): Usage => ({
      inputTokens: n,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const long = "a".repeat(3_000);
    const model = new FakeModelClient([
      ...Array.from({ length: 6 }, (_, i) =>
        reply([toolUse("upper", { text: `${long}${i}` })], undefined, heavy(3_000 * (i + 1))),
      ),
      // The context is now 18 050 tokens (> 80% of 20 000): the next call is the summary.
      reply([text("Summary: six long texts were shouted.")]),
      reply([text("All done.")]),
    ]);
    const tools = new ToolRegistry([upperTool()]);
    const result = await runAgent(session, {
      model,
      tools,
      system: "s",
      permissions: allowAll(),
      ...small,
    });
    expect(result.stopReason).toBe("done");
    expect(journal.records.some((r) => r.type === "compaction" && r.stage === "summary")).toBe(
      true,
    );

    const report = await replaySession(journal.records, tools);
    expect(report.problems).toEqual([]);
    expect(report.matches).toBe(true);
  });
});
