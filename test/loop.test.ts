import { describe, expect, it } from "vitest";
import {
  type AgentEvent,
  continuationNote,
  DEFAULT_MAX_TOKENS,
  MAX_OUTPUT_RECOVERIES,
  RECOVERY_MAX_TOKENS,
  runAgent,
} from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { ToolResultBlock } from "../src/model/types.js";
import { rebuildState } from "../src/session/resume.js";
import { addUserMessage, createSession } from "../src/session/session.js";
import { MemoryJournal } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { allowAll, failTool, upperTool } from "./helpers.js";

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
      permissions: allowAll(),
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
      permissions: allowAll(),
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
    await runAgent(session, {
      model,
      tools: new ToolRegistry([upperTool(calls)]),
      system: SYSTEM,
      permissions: allowAll(),
    });

    expect(calls).toEqual(["a", "b"]);
    expect(
      session.messages[2]?.content.map((b) => b.type === "tool_result" && b.toolUseId),
    ).toEqual(["t1", "t2"]);
  });

  it("returns an unknown tool to the model as an error result", async () => {
    const model = new FakeModelClient([reply([toolUse("nope", {})]), reply([text("ok")])]);
    await runAgent(newSession(), {
      model,
      tools: new ToolRegistry(),
      system: SYSTEM,
      permissions: allowAll(),
    });
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
    await runAgent(newSession(), {
      model,
      tools: new ToolRegistry([upperTool()]),
      system: SYSTEM,
      permissions: allowAll(),
    });
    const result = lastToolResult(model);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/invalid input for upper/);
    expect(result.content).toMatch(/text/);
  });

  it("returns a tool exception to the model as an error result", async () => {
    const model = new FakeModelClient([reply([toolUse("fail", {})]), reply([text("ok")])]);
    await runAgent(newSession(), {
      model,
      tools: new ToolRegistry([failTool]),
      system: SYSTEM,
      permissions: allowAll(),
    });
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
      permissions: allowAll(),
      maxSteps: 3,
    });
    expect(result).toMatchObject({ stopReason: "max_steps", steps: 3 });
    expect(model.requests).toHaveLength(3);
  });

  it("reports max_tokens (after the recoveries) and refusal stop reasons", async () => {
    const refusal = new FakeModelClient([reply([text("no")], "refusal")]);
    const refused = await runAgent(newSession(), {
      model: refusal,
      tools: new ToolRegistry(),
      system: SYSTEM,
      permissions: allowAll(),
    });
    expect(refused.stopReason).toBe("refusal");
    const cut = () => reply([text("cut")], "max_tokens");
    const model = new FakeModelClient(
      Array.from({ length: MAX_OUTPUT_RECOVERIES + 1 }, () => cut()),
    );
    const result = await runAgent(newSession(), {
      model,
      tools: new ToolRegistry(),
      system: SYSTEM,
      permissions: allowAll(),
    });
    expect(result).toMatchObject({ stopReason: "max_tokens", steps: MAX_OUTPUT_RECOVERIES + 1 });
  });

  it("goes on after a response cut off at the output limit, with more room (0.12)", async () => {
    const calls: string[] = [];
    const thinking = { type: "thinking" as const, text: "long plan", wire: { signature: "s" } };
    const model = new FakeModelClient([
      reply([thinking, text("Part one."), toolUse("upper", { te: "x" }, "cut1")], "max_tokens"),
      reply([toolUse("upper", { text: "hi" }, "t2")]),
      reply([text("Done: HI.")]),
    ]);
    const session = newSession();
    const journal = new MemoryJournal();
    session.journal = journal;
    const events: AgentEvent[] = [];
    const result = await runAgent(session, {
      model,
      tools: new ToolRegistry([upperTool(calls)]),
      system: SYSTEM,
      permissions: allowAll(),
      onEvent: (e) => events.push(e),
    });
    expect(result).toMatchObject({ stopReason: "done", steps: 3 });
    expect(calls).toEqual(["hi"]);
    // The first request had the default limit; after the cut-off, 32k.
    expect(model.requests.map((r) => r.maxTokens)).toEqual([
      DEFAULT_MAX_TOKENS,
      RECOVERY_MAX_TOKENS,
      RECOVERY_MAX_TOKENS,
    ]);
    // The cut-off response keeps its text only; then Garuda's note.
    const second = model.requests[1]?.messages ?? [];
    expect(second.at(-2)).toEqual({ role: "assistant", content: [text("Part one.")] });
    expect(second.at(-1)).toEqual({
      role: "user",
      content: [text(continuationNote(DEFAULT_MAX_TOKENS, true))],
    });
    expect(continuationNote(DEFAULT_MAX_TOKENS, true)).toMatch(
      /cut off before its tool call was complete, so the call did not run\. Go on/,
    );
    expect(events).toContainEqual({
      type: "notice",
      text: `The response hit the output limit (${DEFAULT_MAX_TOKENS} tokens); Garuda asks the model to go on with ${RECOVERY_MAX_TOKENS}.`,
    });
    // The journal has a continue record, and a resume rebuilds the same conversation.
    expect(journal.records.filter((r) => r.type === "continue")).toHaveLength(1);
    expect(rebuildState(journal.records).messages.slice(-5)).toEqual(session.messages.slice(-5));
  });

  it("drops a cut-off response that has only thinking, and still counts its tokens (0.12)", async () => {
    const thinking = { type: "thinking" as const, text: "t", wire: {} };
    const model = new FakeModelClient([
      reply([thinking], "max_tokens", {
        inputTokens: 10,
        outputTokens: 8192,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
      reply([text("Short answer.")]),
    ]);
    const session = newSession();
    const result = await runAgent(session, {
      model,
      tools: new ToolRegistry(),
      system: SYSTEM,
      permissions: allowAll(),
    });
    expect(result.stopReason).toBe("done");
    expect(result.usage.outputTokens).toBe(8197);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    expect(continuationNote(8192, false)).not.toMatch(/tool call/);
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
        permissions: allowAll(),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(model.requests).toHaveLength(0);
  });
});
