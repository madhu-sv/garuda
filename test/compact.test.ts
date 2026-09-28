import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compactIfNeeded, SUMMARY_SYSTEM, splitIndex } from "../src/context/compact.js";
import {
  buildSystemPrompt,
  INSTRUCTIONS_MAX_CHARS,
  loadInstructions,
} from "../src/context/instructions.js";
import { runAgent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { Message, Usage } from "../src/model/types.js";
import { addUserMessage, createSession, type Session } from "../src/session/session.js";
import { MemoryJournal } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { allowAll, upperTool } from "./helpers.js";

const signal = new AbortController().signal;
const big = "x".repeat(5_000);

/** A session with `steps` finished tool steps, each with a long tool output. */
function longSession(steps: number): Session {
  const session = createSession("/tmp/p", "s", new MemoryJournal());
  addUserMessage(session, "Fix the bug in parser.ts");
  for (let i = 0; i < steps; i++) {
    session.messages.push({
      role: "assistant",
      content: [text(`step ${i}`), toolUse("read_file", { path: `f${i}.ts` }, `c${i}`)],
    });
    session.messages.push({
      role: "user",
      content: [{ type: "tool_result", toolUseId: `c${i}`, content: big, isError: false }],
    });
  }
  return session;
}

/** Every tool_use has its tool_result right after it, and roles alternate. */
function expectValid(messages: readonly Message[]) {
  expect(messages[0]?.role).toBe("user");
  messages.forEach((m, i) => {
    if (i > 0) expect(m.role).not.toBe(messages[i - 1]?.role);
    const ids = m.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
    const next = messages[i + 1]?.content ?? [];
    for (const id of ids) {
      expect(next.some((b) => b.type === "tool_result" && b.toolUseId === id)).toBe(true);
    }
  });
}

describe("compaction (F23)", () => {
  it("does nothing below 80% of the window", async () => {
    const session = longSession(6);
    session.contextTokens = 79_000;
    const model = new FakeModelClient([]);
    expect(
      await compactIfNeeded(session, model, { contextWindow: 100_000 }, signal),
    ).toBeUndefined();
  });

  it("splits before the 4th assistant turn from the end", () => {
    const session = longSession(6);
    expect(splitIndex(session.messages, 4)).toBe(5);
    expect(session.messages[5]?.role).toBe("assistant");
    expect(splitIndex(session.messages, 7)).toBe(-1);
  });

  it("stage 1 cuts old tool outputs and keeps the last 4 turns in full, with no model call", async () => {
    const session = longSession(6);
    session.contextTokens = 10_000; // Window 11 000: 91%. Cutting 2 × ~4 800 chars saves ~2 400 tokens.
    const model = new FakeModelClient([]);
    const result = await compactIfNeeded(
      session,
      model,
      { contextWindow: 11_000, target: 0.9 },
      signal,
    );
    expect(result).toMatchObject({ stage: "trim", beforeTokens: 10_000 });
    expect(result?.afterTokens).toBeLessThan(8_000);
    const outputs = session.messages.flatMap((m) =>
      m.content.flatMap((b) => (b.type === "tool_result" ? [b.content.length] : [])),
    );
    expect(outputs.slice(0, 2).every((n) => n < 400)).toBe(true);
    expect(outputs.slice(2)).toEqual([5_000, 5_000, 5_000, 5_000]);
    expect(session.messages[1]?.content).toHaveLength(2);
    expectValid(session.messages);
    expect(session.journal).toBeInstanceOf(MemoryJournal);
    expect((session.journal as MemoryJournal).records.at(-1)).toMatchObject({
      type: "compaction",
      stage: "trim",
    });
  });

  it("stage 2 asks the model for a summary of older turns when trimming is not enough", async () => {
    const session = longSession(8);
    session.contextTokens = 95_000;
    const before = structuredClone(session.messages);
    const summaryUsage: Usage = {
      inputTokens: 3_000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const model = new FakeModelClient([
      (request) => {
        expect(request.system).toBe(SUMMARY_SYSTEM);
        expect(request.tools).toEqual([]);
        const prompt = request.messages[0]?.content[0];
        expect(prompt?.type === "text" && prompt.text).toContain("User: Fix the bug in parser.ts");
        expect(prompt?.type === "text" && prompt.text).toContain(
          'Agent called read_file {"path":"f0.ts"}',
        );
        return reply(
          [text("The user wants the parser bug fixed. Files f0–f3 were read.")],
          "end_turn",
          summaryUsage,
        );
      },
    ]);
    const result = await compactIfNeeded(
      session,
      model,
      { contextWindow: 100_000, costOf: () => 0.01 },
      signal,
    );

    expect(result?.stage).toBe("summary");
    expect(session.messages).toHaveLength(1 + 8);
    const opening = session.messages[0]?.content[0];
    expect(opening?.type === "text" && opening.text).toContain("Fix the bug in parser.ts");
    expect(opening?.type === "text" && opening.text).toContain("Files f0–f3 were read.");
    expectValid(session.messages);
    expect(session.usage.inputTokens).toBe(3_000);
    expect(session.costUsd).toBeCloseTo(0.01);
    expect(session.contextTokens).toBe(result?.afterTokens);
    // The estimate keeps the part outside the messages (system prompt, tools): only the saved
    // characters come off (0.8; live test: 26.1k → "about 2.5k" was the messages alone).
    const chars = JSON.stringify(before).length;
    expect(result?.afterTokens).toBeGreaterThan(95_000 - chars / 4);
    expect(result?.afterTokens).toBeLessThan(95_000);
  });

  it("the loop compacts before a model call and keeps system and tools stable (N2)", async () => {
    const session = longSession(8);
    session.contextTokens = 95_000;
    const model = new FakeModelClient([
      reply([text("summary")]),
      reply([toolUse("upper", { text: "a" })]),
      reply([text("done")]),
    ]);
    const events: string[] = [];
    await runAgent(session, {
      model,
      tools: new ToolRegistry([upperTool()]),
      system: "stable system",
      permissions: allowAll(),
      contextWindow: 100_000,
      onEvent: (e) => events.push(e.type),
    });
    expect(events[0]).toBe("compaction");
    const main = model.requests.slice(1);
    expect(main).toHaveLength(2);
    for (const request of main) {
      expect(request.system).toBe("stable system");
      expect(request.tools).toEqual(main[0]?.tools);
    }
  });
});

describe("instruction files (F21)", () => {
  it("adds the file to the system prompt; no file gives the base prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "garuda-md-"));
    try {
      expect(await loadInstructions(root)).toEqual([]);
      writeFileSync(join(root, "GARUDA.md"), "Use pnpm, not npm.\n");
      const instructions = await loadInstructions(root);
      expect(instructions).toEqual([{ name: "GARUDA.md", text: "Use pnpm, not npm." }]);
      const prompt = buildSystemPrompt(root, instructions);
      expect(prompt).toContain("# Project instructions (GARUDA.md)");
      expect(prompt.endsWith("Use pnpm, not npm.")).toBe(true);
      expect(buildSystemPrompt(root, undefined)).not.toContain("GARUDA.md");
      expect(buildSystemPrompt(root, [])).toBe(buildSystemPrompt(root, undefined));
      // Same input, same bytes (N2).
      expect(buildSystemPrompt(root, instructions)).toBe(prompt);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads AGENTS.md, CLAUDE.md and GARUDA.md in that order, once each, within one size limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "garuda-md-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "Run tests with npm test.\n");
      // The same text (for example a link to AGENTS.md) goes in once.
      writeFileSync(join(root, "CLAUDE.md"), "Run tests with npm test.");
      writeFileSync(join(root, "GARUDA.md"), "Run tests with pnpm test.\n");
      const files = await loadInstructions(root);
      expect(files.map((f) => f.name)).toEqual(["AGENTS.md", "GARUDA.md"]);
      const prompt = buildSystemPrompt(root, files);
      expect(prompt).toContain("# Project instructions (AGENTS.md, GARUDA.md)");
      expect(prompt).toContain("When two files disagree, the later file wins.");
      expect(prompt.indexOf("## AGENTS.md")).toBeLessThan(prompt.indexOf("## GARUDA.md"));
      expect(prompt.endsWith("Run tests with pnpm test.")).toBe(true);

      // An empty file is skipped; a folder with the name is skipped too.
      writeFileSync(join(root, "GARUDA.md"), "   \n");
      rmSync(join(root, "CLAUDE.md"));
      mkdirSync(join(root, "CLAUDE.md"));
      expect((await loadInstructions(root)).map((f) => f.name)).toEqual(["AGENTS.md"]);

      // Together they stay within the limit; GARUDA.md keeps its text first.
      writeFileSync(join(root, "AGENTS.md"), "a".repeat(INSTRUCTIONS_MAX_CHARS));
      writeFileSync(join(root, "GARUDA.md"), "Keep this.");
      const big = await loadInstructions(root);
      expect(big.find((f) => f.name === "GARUDA.md")?.text).toBe("Keep this.");
      const agents = big.find((f) => f.name === "AGENTS.md")?.text ?? "";
      expect(agents).toMatch(
        /\[AGENTS\.md cut: the instruction files may hold 40000 characters together\]$/,
      );
      expect(agents.length).toBeLessThan(INSTRUCTIONS_MAX_CHARS + 100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
