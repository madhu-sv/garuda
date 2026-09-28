import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { transcript } from "../src/context/compact.js";
import { runAgent } from "../src/loop/runAgent.js";
import { fromWireMessage, toWireMessage, toWireParams } from "../src/model/anthropic.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { toWireMessages } from "../src/model/openaiCompatible.js";
import { withoutThinking } from "../src/model/thinking.js";
import type { Message, ThinkingBlock } from "../src/model/types.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import { Redactor } from "../src/session/redact.js";
import { resumeSession } from "../src/session/resume.js";
import { createSession } from "../src/session/session.js";
import { FileSessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { allowAll, upperTool } from "./helpers.js";

/** Claude's thinking blocks (0.9): kept, sent back unchanged, and left out only where they cannot go back. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-thinking-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const dir = () => join(base, `p${n++}`);

// A signature that looks like a secret to the redactor: it must stay byte for byte.
const SIGNATURE = "EqQBCgIYAhIMsk-ant-abcdefghijklmnopqrstuvwxyz0123";
const WIRE_THINKING = { type: "thinking", thinking: "", signature: SIGNATURE };
const WIRE_REDACTED = { type: "redacted_thinking", data: "sk-ant-abcdefghijklmnopqrstuvwxyz" };
const thinking: ThinkingBlock = { type: "thinking", text: "", wire: WIRE_THINKING };

describe("thinking blocks (0.9)", () => {
  it("the adapter keeps thinking and redacted_thinking, and sends them back unchanged", () => {
    const response = fromWireMessage({
      content: [
        { type: "thinking", thinking: "Check the tests first.", signature: SIGNATURE },
        WIRE_REDACTED,
        { type: "tool_use", id: "t1", name: "glob", input: { pattern: "*" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Messages.Message);
    expect(response.content.map((b) => b.type)).toEqual(["thinking", "thinking", "tool_use"]);
    expect(response.content[0]).toMatchObject({ text: "Check the tests first." });
    const wire = toWireMessage({ role: "assistant", content: response.content });
    expect(wire.content).toEqual([
      { type: "thinking", thinking: "Check the tests first.", signature: SIGNATURE },
      WIRE_REDACTED,
      { type: "tool_use", id: "t1", name: "glob", input: { pattern: "*" } },
    ]);
    // A thinking block takes no cache mark.
    const params = toWireParams("m", {
      system: "s",
      messages: [{ role: "assistant", content: [text("a"), thinking] }],
      tools: [],
      maxTokens: 1,
    });
    const blocks = params.messages[0]?.content as { cache_control?: unknown }[];
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1]?.cache_control).toBeUndefined();
  });

  it("the loop sends the thinking of a tool-use step back with the next request", async () => {
    const root = dir();
    for (const keep of [true, false]) {
      const model = new FakeModelClient([
        reply([thinking, toolUse("upper", { text: "a" }, "u1")], "tool_use"),
        (request) => {
          const assistant = request.messages.find((m) => m.role === "assistant");
          const types = assistant?.content.map((b) => b.type);
          expect(types).toEqual(keep ? ["thinking", "tool_use"] : ["tool_use"]);
          return reply([text("Done.")]);
        },
      ]);
      const session = createSession(root, `s${keep}`);
      session.messages.push({ role: "user", content: [text("find files")] });
      await runAgent(session, {
        model,
        tools: new ToolRegistry([upperTool([])]),
        system: "s",
        permissions: allowAll(),
        ...(keep ? {} : { keepThinking: false }),
      });
      expect(model.remaining).toBe(0);
    }
  });

  it("the session file keeps signatures and redacted data; a redacted thinking text is left out on resume", async () => {
    const root = dir();
    const store = new FileSessionStore(root, new Redactor({}));
    const journal = store.open("s1");
    const start = {
      root,
      version: "t",
      model: "claude-sonnet-5",
      executor: "host",
      isolation: "none",
      limits: { maxSteps: 1, tokenBudget: 1, contextWindow: 1 },
    };
    journal.write({ type: "start", sessionId: "s1", ...start });
    journal.write({ type: "user", message: { role: "user", content: [text("go")] } });
    const leaky: ThinkingBlock = {
      type: "thinking",
      text: "The key is sk-ant-abcdefghijklmnopqrstuvwxyz",
      wire: {
        type: "thinking",
        thinking: "The key is sk-ant-abcdefghijklmnopqrstuvwxyz",
        signature: SIGNATURE,
      },
    };
    journal.write({
      type: "assistant",
      step: 1,
      response: reply([thinking, { type: "thinking", text: "", wire: WIRE_REDACTED }, text("A")]),
    });
    journal.write({ type: "assistant", step: 2, response: reply([leaky, text("B")]) });
    const records = await store.read("s1");
    expect(JSON.stringify(records)).toContain(SIGNATURE);
    expect(JSON.stringify(records)).toContain(WIRE_REDACTED.data);
    expect(JSON.stringify(records)).not.toContain("The key is sk-ant");

    const same = await resumeSession({ store, root, sessionId: "s1", start });
    expect(same.messages[1]?.content.map((b) => b.type)).toEqual(["thinking", "thinking", "text"]);
    expect(same.messages[1]?.content[0]).toEqual(thinking);
    expect(same.messages[2]?.content.map((b) => b.type)).toEqual(["text"]);
    // Another model: no thinking carries over.
    const other = await resumeSession({
      store,
      root,
      sessionId: "s1",
      start: { ...start, model: "claude-opus-5-5" },
    });
    expect(other.messages.flatMap((m) => m.content.map((b) => b.type))).not.toContain("thinking");
  });

  it("/models drops the thinking of the old model", async () => {
    const root = dir();
    const model = new FakeModelClient([reply([thinking, text("Hi.")])]);
    const runtime = await Runtime.create({
      root,
      modelId: "claude-sonnet-5",
      model: async () => model,
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      profiles: [],
      models: {
        configured: [],
        resolve: () =>
          ({
            spec: "claude-opus-5-5",
            info: { contextWindow: 1_000_000 },
            model: async () => new FakeModelClient([]),
          }) as never,
      },
    });
    await runtime.runTurn("hello", new AbortController().signal);
    expect(JSON.stringify(runtime.session?.messages)).toContain(SIGNATURE);
    const switched = await runtime.setModel("claude-opus-5-5");
    expect(switched.ok).toBe(true);
    expect(JSON.stringify(runtime.session?.messages)).not.toContain(SIGNATURE);
    expect(runtime.session?.messages.at(-1)?.content).toEqual([text("Hi.")]);
  });

  it("the summary, other providers and withoutThinking leave thinking out", () => {
    const messages: Message[] = [
      { role: "user", content: [text("go")] },
      { role: "assistant", content: [{ ...thinking, text: "secret plan" }, text("ok")] },
      { role: "assistant", content: [thinking] },
    ];
    expect(transcript(messages)).not.toContain("secret plan");
    expect(JSON.stringify(toWireMessages("s", messages))).not.toContain("thinking");
    expect(withoutThinking(messages)).toEqual([
      { role: "user", content: [text("go")] },
      { role: "assistant", content: [text("ok")] },
    ]);
  });
});
