import { afterAll, describe, expect, it } from "vitest";
import { type AgentEvent, runAgent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { ModelRequest, ToolResultBlock } from "../src/model/types.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { addUserMessage, createSession } from "../src/session/session.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { makeSampleRepo } from "./sampleRepo.js";

const repo = makeSampleRepo();
afterAll(repo.cleanup);

function lastResults(request: ModelRequest): ToolResultBlock[] {
  const content = request.messages.at(-1)?.content ?? [];
  return content.filter((b): b is ToolResultBlock => b.type === "tool_result");
}

describe("M2 acceptance", () => {
  it('answers "where is parseConfig defined?" with read-only tools and no approvals', async () => {
    const model = new FakeModelClient([
      reply([
        text("I will search for the definition."),
        toolUse("grep", { pattern: "function\\s+parseConfig", mode: "content" }, "g1"),
        toolUse("glob", { pattern: "src/**/*.ts" }, "g2"),
      ]),
      (request) => {
        // The model sees real tool output from the repo.
        const [grep, glob] = lastResults(request);
        expect(grep?.content).toBe(
          "src/config.ts:7:export function parseConfig(path: string): Config {",
        );
        expect(glob?.content).toContain("src/config.ts");
        return reply([toolUse("read_file", { path: "src/config.ts", offset: 7, limit: 3 }, "r1")]);
      },
      (request) => {
        const [read] = lastResults(request);
        expect(read?.isError).toBe(false);
        expect(read?.content).toContain("     7\texport function parseConfig");
        return reply([text("parseConfig is defined in src/config.ts at line 7.")]);
      },
    ]);

    const events: AgentEvent[] = [];
    const approver = new AutoApprover("deny");
    const session = createSession(repo.root);
    addUserMessage(session, "Where is parseConfig defined?");
    const result = await runAgent(session, {
      model,
      tools: new ToolRegistry(defaultTools()),
      system: "test",
      permissions: new PermissionEngine({ root: repo.root, approver }),
      onEvent: (e) => events.push(e),
    });

    expect(result).toMatchObject({ stopReason: "done", steps: 3 });
    expect(model.remaining).toBe(0);
    const calls = events.flatMap((e) => (e.type === "tool_call" ? [e.call.name] : []));
    expect(calls.sort()).toEqual(["glob", "grep", "read_file"]);
    const errors = events.filter((e) => e.type === "tool_result" && e.outcome.isError);
    expect(errors).toEqual([]);
    expect(approver.requests).toEqual([]);
  });
});
