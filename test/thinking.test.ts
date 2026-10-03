import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime, type RuntimeOptions } from "../src/app/runtime.js";
import { runCommand } from "../src/cli/chat/commands.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { transcript } from "../src/context/compact.js";
import { runAgent, thinkingMaxTokens } from "../src/loop/runAgent.js";
import { fromWireMessage, toWireMessage, toWireParams } from "../src/model/anthropic.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { toWireMessages } from "../src/model/openaiCompatible.js";
import { lookupModel } from "../src/model/pricing.js";
import { resolveModel } from "../src/model/providers.js";
import {
  changeThinking,
  fitThinking,
  thinkingRequest,
  withoutThinking,
} from "../src/model/thinking.js";
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

  it("after a message that redaction changed, no thinking block goes back (its signature binds the prefix)", async () => {
    const root = dir();
    const store = new FileSessionStore(root, new Redactor({}));
    const journal = store.open("s2");
    const start = {
      root,
      version: "t",
      model: "claude-fable-5-1",
      executor: "host",
      isolation: "none",
      limits: { maxSteps: 1, tokenBudget: 1, contextWindow: 1 },
    };
    journal.write({ type: "start", sessionId: "s2", ...start });
    journal.write({ type: "user", message: { role: "user", content: [text("review")] } });
    journal.write({
      type: "assistant",
      step: 1,
      response: reply([thinking, toolUse("read_file", {}, "r1")]),
    });
    // The tool result holds a secret: on disk it is changed.
    journal.write({
      type: "tool_results",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "r1",
            content: "token=m0_canary_secret_123456",
            isError: false,
          },
        ],
      },
      calls: [],
    });
    journal.write({
      type: "assistant",
      step: 2,
      response: reply([thinking, toolUse("read_file", {}, "r2")]),
    });
    journal.write({
      type: "tool_results",
      message: {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "r2", content: "ok", isError: false }],
      },
      calls: [],
    });
    const resumed = await resumeSession({ store, root, sessionId: "s2", start });
    const kinds = resumed.messages.map((m) => m.content.map((b) => b.type).join(","));
    // Before the changed message: thinking kept. After it: left out.
    expect(kinds[1]).toBe("thinking,tool_use");
    expect(kinds[3]).toBe("tool_use");
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

describe("/thinking (0.9)", () => {
  const ALWAYS = lookupModel("claude-sonnet-5").thinking;
  const OPTIONAL = lookupModel("claude-sonnet-4-6").thinking;

  it("the CLI's resolved model carries the thinking facts (live test: /thinking said no)", () => {
    expect(resolveModel("claude-sonnet-5").info.thinking?.mode).toBe("always");
    expect(resolveModel("anthropic/claude-opus-4-8").info.thinking?.mode).toBe("optional");
    expect(resolveModel("ollama/qwen3-coder:30b").info.thinking).toBeUndefined();
  });

  it("maps a choice to request fields per model", () => {
    expect(ALWAYS?.mode).toBe("always");
    expect(OPTIONAL?.efforts).not.toContain("xhigh");
    expect(lookupModel("claude-haiku-4-5").thinking).toBeUndefined();
    // Summaries always stream (no 5-minute silence); hidden unless the user says show (0.14).
    expect(thinkingRequest({}, ALWAYS)).toEqual({ display: "summarized", hide: true });
    expect(thinkingRequest({ effort: "low", show: true }, ALWAYS)).toEqual({
      effort: "low",
      display: "summarized",
    });
    // Optional models: show alone must not turn thinking on.
    expect(thinkingRequest({ show: true }, OPTIONAL)).toBeUndefined();
    expect(thinkingRequest({ enabled: true, show: false }, OPTIONAL)).toEqual({
      adaptive: true,
      display: "summarized",
      hide: true,
    });
    expect(thinkingRequest({ effort: "high" }, undefined)).toBeUndefined();

    const params = toWireParams("claude-sonnet-5", {
      system: "s",
      messages: [],
      tools: [],
      maxTokens: 1,
      thinking: { effort: "max", display: "summarized" },
    });
    expect(params.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(params.output_config).toEqual({ effort: "max" });
    const plain = toWireParams("m", { system: "s", messages: [], tools: [], maxTokens: 1 });
    expect(plain.thinking).toBeUndefined();
    expect(plain.output_config).toBeUndefined();
    expect(thinkingMaxTokens(8192, undefined)).toBe(8192);
    expect(thinkingMaxTokens(8192, { effort: "low" })).toBe(16_384);
    expect(thinkingMaxTokens(8192, { effort: "max" })).toBe(32_000);
  });

  it("changes the choice with one word, and refuses what the model cannot do", () => {
    const ok = (c: ReturnType<typeof changeThinking>) => (c.ok ? c.choice : undefined);
    expect(ok(changeThinking({}, "high", ALWAYS, "claude-sonnet-5"))).toEqual({ effort: "high" });
    expect(changeThinking({}, "off", ALWAYS, "claude-sonnet-5")).toMatchObject({
      ok: false,
      text: expect.stringContaining("always thinks"),
    });
    expect(changeThinking({}, "xhigh", OPTIONAL, "claude-sonnet-4-6")).toMatchObject({
      ok: false,
      text: expect.stringContaining("low, medium, high, max"),
    });
    expect(ok(changeThinking({ effort: "low" }, "default", ALWAYS, "m"))).toEqual({});
    expect(ok(changeThinking({}, "on", OPTIONAL, "m"))).toEqual({ enabled: true });
    expect(changeThinking({}, "show", undefined, "ollama/qwen3")).toMatchObject({ ok: false });
    expect(changeThinking({}, "loud", ALWAYS, "m")).toMatchObject({ ok: false });
    expect(fitThinking({ effort: "xhigh", show: true }, OPTIONAL)).toEqual({
      choice: { show: true },
      dropped: ["effort xhigh"],
    });
  });

  it("a model that always thinks gets thinking room by default; others keep 8,192 (0.12)", async () => {
    const limits: Record<string, number> = {};
    for (const modelId of ["claude-sonnet-5", "claude-haiku-4-5"]) {
      const root = dir();
      const model = new FakeModelClient([
        (request) => {
          limits[modelId] = request.maxTokens;
          return reply([text("Done.")]);
        },
      ]);
      const runtime = await Runtime.create({
        root,
        modelId,
        model: async () => model,
        approver: new AutoApprover("once"),
        store: new FileSessionStore(root),
        settings: parseSettings({ executor: "host" }),
        mcp: false,
        hooks: false,
        profiles: [],
      });
      await runtime.runTurn("go", new AbortController().signal);
      await runtime.close();
    }
    expect(limits).toEqual({ "claude-sonnet-5": 16_384, "claude-haiku-4-5": 8_192 });
  });

  it("the chat command sends the choice, records it, and a resume brings it back", async () => {
    const root = dir();
    let asked: unknown;
    const model = new FakeModelClient([
      (request) => {
        asked = request.thinking;
        expect(request.maxTokens).toBeGreaterThanOrEqual(16_384);
        return reply([
          { type: "thinking", text: "Look at math.js first.", wire: WIRE_THINKING },
          text("Done."),
        ]);
      },
    ]);
    const store = new FileSessionStore(root);
    const options = {
      root,
      modelId: "claude-sonnet-5",
      model: async () => model,
      approver: new AutoApprover("once"),
      store,
      settings: parseSettings({ executor: "host", thinking: { effort: "low" } }),
      mcp: false,
      hooks: false,
      profiles: [],
    } satisfies RuntimeOptions;
    const runtime = await Runtime.create(options);
    const chat = new ChatStore({ model: "m", sandbox: "s" }, { paint: noColor });
    const run = (line: string) =>
      runCommand(line, { runtime, renderer: chat, sessionPath: (id) => id });
    await run("/thinking");
    expect(chat.getState().items.at(-1)?.text).toBe(
      "Thinking for claude-sonnet-5: always on · effort low · text hidden.",
    );
    await run("/thinking show");
    // Show and hide change only the screen (0.14): the request and the cache stay the same.
    expect(chat.getState().items.at(-1)?.text).toMatch(
      /text shown \(dimmed; Ctrl-O shows all\)\.$/,
    );
    await run("/thinking off");
    expect(chat.getState().items.at(-1)?.text).toMatch(/always thinks/);

    await runtime.runTurn("go", new AbortController().signal);
    expect(asked).toEqual({ effort: "low", display: "summarized" });

    const again = await Runtime.create({
      ...options,
      settings: parseSettings({ executor: "host" }),
      resume: true,
    });
    expect(again.thinkingStatus()).toContain("effort low · text shown");
  });

  it("shows readable thinking dimmed, then the answer; Ctrl-O has all of it", () => {
    const chat = new ChatStore({ model: "m", sandbox: "s" }, { paint: noColor });
    const long = ["one", "two", "three", "four", "five", "six"].join("\n");
    chat.event({ type: "thinking_delta", text: long });
    chat.event({ type: "text_delta", text: "The answer.\n\n" });
    const texts = chat.getState().items.map((i) => i.text);
    expect(texts[0]).toBe("✻ one\n  two\n  three\n  four\n  … 2 more line(s): Ctrl-O");
    expect(texts[1]).toBe("The answer.");
  });
});
