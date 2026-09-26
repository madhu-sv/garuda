import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { JsonOutput, resultLine } from "../src/cli/jsonOutput.js";
import type { Renderer } from "../src/cli/renderer.js";
import { runTurnInTerminal } from "../src/cli/turn.js";
import type { AgentResult } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import { FileSessionStore } from "../src/session/store.js";
import { VERSION } from "../src/version.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-json-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function project(): string {
  const root = join(base, `p${n++}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a.txt"), "hello\n");
  return root;
}

/** Collects what goes to stderr. */
class Log implements Renderer {
  readonly lines: string[] = [];
  event(): void {
    this.lines.push("event");
  }
  info(t: string): void {
    this.lines.push(`info ${t}`);
  }
  warn(t: string): void {
    this.lines.push(`warn ${t}`);
  }
  error(t: string): void {
    this.lines.push(`error ${t}`);
  }
}

async function run(format: "json" | "stream-json", model: FakeModelClient, verbose = false) {
  const root = project();
  const stdout: string[] = [];
  const log = new Log();
  let runtime: Runtime | undefined;
  const output = new JsonOutput({
    format,
    write: (line) => stdout.push(line),
    log,
    verbose,
    sessionId: () => runtime?.session?.id ?? "",
    runInfo: () => ({
      cwd: root,
      model: "fake-model",
      tools: runtime?.toolNames() ?? [],
      mcpServers: [{ name: "gh", state: "denied" }],
      permissionMode: "default",
      slashCommands: ["help"],
      apiKeySource: "none",
    }),
  });
  // Writes ask and get "deny"; reads need no question.
  runtime = await Runtime.create({
    root,
    modelId: "fake-model",
    model: async () => model,
    approver: new AutoApprover("deny"),
    store: new FileSessionStore(root),
    settings: parseSettings({ executor: "host" }),
    mcp: false,
    hooks: false,
    profiles: [],
    onEvent: (event) => output.event(event),
  });
  const outcome = await runTurnInTerminal(
    runtime,
    { onInterrupt: () => {} },
    output,
    "Read a.txt, then change it.",
    () => {
      throw new Error("exit");
    },
  );
  output.finish(outcome, {
    totalCostUsd: 0.5,
    runCostUsd: 0.25,
    contextWindow: 200_000,
    maxOutputTokens: 8192,
  });
  const lines = stdout.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { lines, stdout, log, sessionId: runtime.session?.id };
}

const script = () =>
  new FakeModelClient([
    reply([text("Let me read it."), toolUse("read_file", { path: "a.txt" }, "t1")]),
    reply([toolUse("write_file", { path: "a.txt", content: "bye\n" }, "t2")]),
    reply([text("I could not change a.txt: the write was denied.")]),
  ]);

describe("--output-format stream-json (0.5)", () => {
  it("writes init, then each response and tool result, then the result, one JSON per line", async () => {
    const { lines, sessionId } = await run("stream-json", script());
    expect(lines.map((l) => (l.subtype === undefined ? l.type : `${l.type}/${l.subtype}`))).toEqual(
      ["system/init", "assistant", "user", "assistant", "user", "assistant", "result/success"],
    );
    expect(sessionId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
    for (const line of lines) {
      expect(line.session_id).toBe(sessionId);
      expect(line.uuid).toMatch(/^[0-9a-f-]{36}$/);
    }

    const [init, first, firstResult, , denied, , result] = lines;
    expect(init).toMatchObject({
      cwd: expect.any(String),
      model: "fake-model",
      permissionMode: "default",
      mcp_servers: [{ name: "gh", status: "disabled" }],
      slash_commands: ["help"],
      apiKeySource: "none",
      garuda_version: VERSION,
    });
    expect(init?.tools).toEqual(expect.arrayContaining(["bash", "read_file", "write_file"]));

    expect(first).toMatchObject({
      parent_tool_use_id: null,
      message: {
        type: "message",
        role: "assistant",
        model: "fake-model",
        stop_reason: "tool_use",
        stop_sequence: null,
        content: [
          { type: "text", text: "Let me read it." },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" } },
        ],
        usage: { input_tokens: expect.any(Number), output_tokens: expect.any(Number) },
      },
    });
    expect(firstResult).toMatchObject({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }],
      },
    });
    expect(JSON.stringify(firstResult)).toContain("hello");
    expect(denied).toMatchObject({
      message: { content: [{ tool_use_id: "t2", is_error: true }] },
    });

    expect(result).toMatchObject({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 3,
      result: "I could not change a.txt: the write was denied.",
      stop_reason: "end_turn",
      total_cost_usd: 0.5,
      terminal_reason: "completed",
      permission_denials: [
        {
          tool_name: "write_file",
          tool_use_id: "t2",
          tool_input: { path: "a.txt", content: "bye\n" },
        },
      ],
      modelUsage: {
        "fake-model": { costUSD: 0.25, contextWindow: 200_000, maxOutputTokens: 8192 },
      },
    });
    expect(result?.duration_ms).toEqual(expect.any(Number));
    expect(result?.duration_api_ms).toEqual(expect.any(Number));
    expect(result).not.toHaveProperty("errors");
  });

  it("keeps stderr quiet without --verbose, and shows the activity with it", async () => {
    const quiet = await run("stream-json", script());
    expect(quiet.log.lines).toEqual([]);
    const loud = await run("stream-json", script(), true);
    expect(loud.log.lines).toContain("event");
    expect(loud.log.lines.some((l) => l.startsWith("info "))).toBe(true);
  });
});

describe("--output-format json (0.5)", () => {
  it("writes only the result line", async () => {
    const { lines, stdout, sessionId } = await run("json", script());
    expect(stdout).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: "result",
      subtype: "success",
      result: "I could not change a.txt: the write was denied.",
      session_id: sessionId,
    });
  });
});

describe("the result line (0.5)", () => {
  const info = {
    totalCostUsd: 0,
    runCostUsd: undefined,
    contextWindow: 1000,
    maxOutputTokens: 100,
    model: "m",
    durationMs: 5,
    lastText: "text",
    denials: [],
  };
  const done = (stopReason: AgentResult["stopReason"]) => ({
    kind: "done" as const,
    result: {
      stopReason,
      steps: 50,
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      apiMs: 12.6,
    },
  });

  it("maps Garuda's stop reasons to Claude Code's subtypes", () => {
    expect(
      resultLine(done("max_steps"), { ...info, stopMessage: "Stopped: step limit" }),
    ).toMatchObject({
      subtype: "error_max_turns",
      is_error: false,
      errors: ["Stopped: step limit"],
      terminal_reason: "max_turns",
      duration_api_ms: 13,
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
      },
    });
    expect(resultLine(done("max_steps"), info)).not.toHaveProperty("result");
    expect(resultLine(done("token_budget"), info)).toMatchObject({
      subtype: "error_during_execution",
      terminal_reason: "budget_exhausted",
    });
    expect(resultLine(done("repeated_calls"), info)).toMatchObject({
      subtype: "error_during_execution",
    });
    expect(resultLine(done("max_tokens"), info)).toMatchObject({
      subtype: "success",
      result: "text",
    });
  });

  it("reports an error and a stop by the user", () => {
    expect(resultLine({ kind: "error", message: "no key" }, info)).toMatchObject({
      subtype: "error_during_execution",
      is_error: true,
      errors: ["no key"],
      num_turns: 0,
      stop_reason: null,
    });
    expect(resultLine({ kind: "interrupted" }, info)).toMatchObject({
      subtype: "error_during_execution",
      is_error: false,
      errors: ["Interrupted."],
    });
  });
});
