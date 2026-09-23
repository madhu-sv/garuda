import { describe, expect, it } from "vitest";
import { type AgentEvent, runAgent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { ToolResultBlock } from "../src/model/types.js";
import { addUserMessage, createSession } from "../src/session/session.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { failTool, upperTool } from "./helpers.js";

const SYSTEM = "test system prompt";

function newSession(prompt = "shout hello") {
  const session = createSession("/tmp/project", "s1");
  addUserMessage(session, prompt);
  return session;
}

function lastToolResult(model: FakeModelClient): ToolResultBlock {
  const last = model.requests.at(-1)?.messages.at(-1);
  const block = last?.content[0];
  if (block?.type !== "tool_result") throw new Error("expected a tool_result");
  return block;
}

describe("runAgent (F5)", () => {
  it("M1 acceptance: runs two turns against a scripted fake model", async () => {
    const calls: string[] = [];
    const model = new FakeModelClient([
      reply([text("I will call the tool."), toolUse("upper", { text: "hello" }, "t1")]),
      reply([text("The answer is HELLO.")]),
    ]);
    const events: AgentEvent[] = [];
    const session = newSession();

    const result = await runAgent(session, {
      model,
      tools: new ToolRegistry([upperTool(calls)]),
      system: SYSTEM,
      onEvent: (e) => events.push(e),
    });

    expect(result.stopReason).toBe("done");
    expect(result.steps).toBe(2);
    expect(model.remaining).toBe(0);
    expect(calls).toEqual(["hello"]);

    // Conversation shape: user, assistant(tool_use), user(tool_result), assistant(text).
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(session.messages[2]?.content).toEqual([
      { type: "tool_result", toolUseId: "t1", content: "HELLO", isError: false },
    ]);

    // The second request carries the tool result and the same system prompt and tools.
    expect(model.requests).toHaveLength(2);
    expect(lastToolResult(model).content).toBe("HELLO");
    expect(model.requests[1]?.system).toBe(SYSTEM);
    expect(model.requests[1]?.tools).toEqual(model.requests[0]?.tools);
    expect(model.requests[0]?.tools.map((t) => t.name)).toEqual(["upper"]);

    // Events stream in order.
    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "step_end",
      "tool_call",
      "tool_result",
      "text_delta",
      "step_end",
    ]);

    // Usage adds up in the result and in the session.
    expect(result.usage.inputTokens).toBe(20);
    expect(session.usage.outputTokens).toBe(10);
  });

  it("stops after one step when the model calls no tools", async () => {
    const model = new FakeModelClient([reply([text("Nothing to do.")])]);
    const result = await runAgent(newSession(), {
      model,
      tools: new ToolRegistry(),
      system: SYSTEM,
    });
    expect(result).toMatchObject({ stopReason: "done", steps: 1 });
  });

  it("runs several tool calls of one step in call order", async () => {
    const calls: string[] = [];
    const model = new FakeModelClient([
      reply([toolUse("upper", { text: "a" }, "t1"), toolUse("upper", { text: "b" }, "t2")]),
      reply([text("done")]),
    ]);
    const session = newSession();
    await runAgent(session, { model, tools: new ToolRegistry([upperTool(calls)]), system: SYSTEM });

    expect(calls).toEqual(["a", "b"]);
    expect(
      session.messages[2]?.content.map((b) => b.type === "tool_result" && b.toolUseId),
    ).toEqual(["t1", "t2"]);
  });

  it("returns an unknown tool to the model as an error result", async () => {
    const model = new FakeModelClient([reply([toolUse("nope", {})]), reply([text("ok")])]);
    await runAgent(newSession(), { model, tools: new ToolRegistry(), system: SYSTEM });
    expect(lastToolResult(model)).toMatchObject({
      isError: true,
      content: 'Error: unknown tool "nope".',
    });
  });

  it("returns invalid input to the model as a validation error (F16)", async () => {
    const model = new FakeModelClient([
      reply([toolUse("upper", { text: 42 })]),
      reply([text("ok")]),
    ]);
    await runAgent(newSession(), { model, tools: new ToolRegistry([upperTool()]), system: SYSTEM });
    const result = lastToolResult(model);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/invalid input for upper/);
    expect(result.content).toMatch(/text/);
  });

  it("returns a tool exception to the model as an error result", async () => {
    const model = new FakeModelClient([reply([toolUse("fail", {})]), reply([text("ok")])]);
    await runAgent(newSession(), { model, tools: new ToolRegistry([failTool]), system: SYSTEM });
    expect(lastToolResult(model)).toMatchObject({
      isError: true,
      content: "Error: fail failed: disk on fire",
    });
  });

  it("stops at the step limit", async () => {
    const steps = Array.from({ length: 5 }, (_, i) => reply([toolUse("upper", { text: `x${i}` })]));
    const model = new FakeModelClient(steps);
    const result = await runAgent(newSession(), {
      model,
      tools: new ToolRegistry([upperTool()]),
      system: SYSTEM,
      maxSteps: 3,
    });
    expect(result).toMatchObject({ stopReason: "max_steps", steps: 3 });
    expect(model.requests).toHaveLength(3);
  });

  it("reports max_tokens and refusal stop reasons", async () => {
    for (const reason of ["max_tokens", "refusal"] as const) {
      const model = new FakeModelClient([reply([text("cut")], reason)]);
      const result = await runAgent(newSession(), {
        model,
        tools: new ToolRegistry(),
        system: SYSTEM,
      });
      expect(result.stopReason).toBe(reason);
    }
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new FakeModelClient([reply([text("never")])]);
    await expect(
      runAgent(newSession(), {
        model,
        tools: new ToolRegistry(),
        system: SYSTEM,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(model.requests).toHaveLength(0);
  });
});
