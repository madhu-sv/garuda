import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import {
  finishResponse,
  OpenAICompatibleClient,
  parseArguments,
  toWireBody,
  toWireMessages,
} from "../src/model/openaiCompatible.js";
import {
  loadModelsConfig,
  OPEN_MODEL_DEFAULT_WINDOW,
  resolveModel,
} from "../src/model/providers.js";
import type { Message, ModelEvent, ModelRequest } from "../src/model/types.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import { FileSessionStore } from "../src/session/store.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-providers-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const request = (
  messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }],
): ModelRequest => ({
  system: "sys",
  messages,
  tools: [{ name: "read_file", description: "Read.", inputSchema: { type: "object" } }],
  maxTokens: 1000,
});

describe("model specs and providers", () => {
  it("a plain id is a Claude model; provider/model picks a provider", () => {
    const claude = resolveModel("claude-sonnet-5");
    expect(claude).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", notes: [] });
    expect(claude.info.price).toBeDefined();

    const local = resolveModel("ollama/qwen3-coder:30b");
    expect(local).toMatchObject({ provider: "ollama", model: "qwen3-coder:30b" });
    expect(local.def.baseUrl).toBe("http://localhost:11434/v1");
    expect(local.info).toEqual({
      contextWindow: OPEN_MODEL_DEFAULT_WINDOW,
      price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(local.notes[0]).toMatch(/assumes a 32768-token context window/);

    const routed = resolveModel("openrouter/qwen/qwen3-coder");
    expect(routed).toMatchObject({ provider: "openrouter", model: "qwen/qwen3-coder" });
    expect(routed.info.price).toBeUndefined();
  });

  it("refuses unknown providers, empty models, clear-text http to other hosts and URL credentials", () => {
    expect(() => resolveModel("nope/x")).toThrow(/Unknown model provider "nope".*ollama/);
    expect(() => resolveModel("ollama/")).toThrow(/names no model/);
    const cfg = (baseUrl: string, extra = {}) => ({
      providers: { lan: { type: "openai-compatible" as const, baseUrl, ...extra } },
      models: {},
    });
    expect(() => resolveModel("lan/m", cfg("http://10.0.0.5:8000/v1"))).toThrow(
      /plain http to 10\.0\.0\.5/,
    );
    expect(
      resolveModel("lan/m", cfg("http://10.0.0.5:8000/v1", { allowInsecureHttp: true })).provider,
    ).toBe("lan");
    expect(() => resolveModel("lan/m", cfg("https://u:p@x.io/v1"))).toThrow(/apiKeyEnv/);
  });

  it("reads ~/.garuda/models.json: providers, context window, price, max tokens", async () => {
    const home = join(base, "home1");
    mkdirSync(join(home, ".garuda"), { recursive: true });
    writeFileSync(
      join(home, ".garuda", "models.json"),
      JSON.stringify({
        providers: {
          box: {
            type: "openai-compatible",
            baseUrl: "https://llm.example.com/v1",
            apiKeyEnv: "BOX_KEY",
          },
        },
        models: {
          "ollama/qwen3-coder:30b": { contextWindow: 65536, maxTokens: 4096 },
          "box/big": { price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
        },
      }),
    );
    const { config, problem } = await loadModelsConfig(home);
    expect(problem).toBeUndefined();
    const local = resolveModel("ollama/qwen3-coder:30b", config);
    expect(local.info.contextWindow).toBe(65536);
    expect(local.maxTokens).toBe(4096);
    expect(local.notes).toEqual([]);
    const box = resolveModel("box/big", config);
    expect(box.info.price?.output).toBe(2);
    await expect(box.create({})).rejects.toThrow("Set BOX_KEY to use the box provider.");

    writeFileSync(
      join(home, ".garuda", "models.json"),
      JSON.stringify({ providers: { x: { type: "grpc" } } }),
    );
    expect((await loadModelsConfig(home)).problem).toMatch(/models\.json/);
    writeFileSync(
      join(home, ".garuda", "models.json"),
      JSON.stringify({ models: { "ollama/m": { textToolCalls: "yes" } } }),
    );
    expect((await loadModelsConfig(home)).problem).toMatch(/textToolCalls/);
  });
});

describe("Chat Completions mapping", () => {
  it("maps tool calls, tool results and Garuda notes", () => {
    const wire = toWireMessages("sys", [
      {
        role: "user",
        content: [
          { type: "text", text: "fix it" },
          { type: "text", text: "<garuda_note>x</garuda_note>" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.js" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "c1", content: "Error: gone", isError: true }],
      },
    ]);
    expect(wire).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "fix it\n\n<garuda_note>x</garuda_note>" },
      {
        role: "assistant",
        content: "Looking.",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.js"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "Error: gone" },
    ]);
    const body = toWireBody("m", { ...request(), tools: [] });
    expect(body).not.toHaveProperty("tools");
    expect(body).toMatchObject({
      model: "m",
      max_tokens: 1000,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("keeps broken tool arguments as a string, so the input check can reject them", () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseArguments("")).toEqual({});
    expect(parseArguments("{oops")).toBe("{oops");
  });

  it("estimates usage when the server sends none", () => {
    const response = finishResponse(
      { text: "done", refusal: "", calls: new Map(), finish: "stop", usage: undefined },
      request(),
    );
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage.inputTokens).toBeGreaterThan(0);
  });
});

// A small fake Chat Completions server.
let server: Server;
let url = "";
let script: ((body: Record<string, unknown>) => {
  status?: number;
  sse?: string[];
  json?: unknown;
})[] = [];
const bodies: Record<string, unknown>[] = [];
const sse = (...chunks: unknown[]) => [
  ...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`),
  "data: [DONE]\n\n",
];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      const step = script.shift()?.(body) ?? {
        status: 500,
        json: { error: { message: "no script" } },
      };
      if (step.sse !== undefined) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Split every event in two writes, to test chunk boundaries.
        for (const event of step.sse) {
          res.write(event.slice(0, 7));
          res.write(event.slice(7));
        }
        res.end();
      } else {
        res.writeHead(step.status ?? 500, { "content-type": "application/json" });
        res.end(JSON.stringify(step.json ?? {}));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function collect(client: OpenAICompatibleClient, req = request()) {
  const events: ModelEvent[] = [];
  for await (const e of client.stream(req)) events.push(e);
  return events;
}

describe("OpenAI-compatible client", () => {
  const client = (extra = {}) =>
    new OpenAICompatibleClient({
      provider: "test",
      baseUrl: url,
      model: "m",
      retryDelaysMs: [0, 0],
      ...extra,
    });

  it("streams text and tool calls split over chunks, with usage", async () => {
    script = [
      () => ({
        sse: sse(
          { choices: [{ delta: { content: "Let me " } }] },
          { choices: [{ delta: { content: "look." } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "c9", function: { name: "read_", arguments: '{"pa' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { name: "file", arguments: 'th":"a.js"}' } }],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 30,
              prompt_tokens_details: { cached_tokens: 100 },
            },
          },
        ),
      }),
    ];
    const events = await collect(client({ apiKey: "k" }));
    expect(
      events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text),
    ).toEqual(["Let me ", "look."]);
    const last = events.at(-1);
    expect(last).toEqual({
      type: "response",
      response: {
        content: [
          { type: "text", text: "Let me look." },
          { type: "tool_use", id: "c9", name: "read_file", input: { path: "a.js" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 20, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0 },
      },
    });
    expect(bodies.at(-1)).toMatchObject({ model: "m", stream: true });
  });

  it("retries a 503, and explains a context error", async () => {
    script = [
      () => ({ status: 503, json: { error: { message: "busy" } } }),
      () => ({ sse: sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) }),
    ];
    expect((await collect(client())).at(-1)).toMatchObject({
      response: { content: [{ text: "ok" }] },
    });

    script = [
      () => ({ status: 400, json: { error: { message: "prompt is too long for context" } } }),
    ];
    await expect(collect(client())).rejects.toThrow(
      /answered 400: prompt is too long.*contextWindow/,
    );
  });

  it("says when the server is not running", async () => {
    // A port that was free a moment ago: nothing listens there.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const down = new OpenAICompatibleClient({
      provider: "ollama",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "m",
      retryDelaysMs: [],
    });
    await expect(collect(down)).rejects.toThrow(
      /Cannot reach ollama at http:\/\/127\.0\.0\.1:\d+\/v1\. Is the server running\?/,
    );
  });

  it("turns a tool call written as text into a real call, and does not show the JSON", async () => {
    script = [
      () => ({
        sse: sse(
          { choices: [{ delta: { content: '{"name": "read_file", ' } }] },
          { choices: [{ delta: { content: '"arguments": {"path": "a.js"}}' } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ),
      }),
    ];
    const events = await collect(client());
    expect(events.filter((e) => e.type === "text_delta")).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      response: {
        content: [{ type: "tool_use", name: "read_file", input: { path: "a.js" } }],
        stopReason: "tool_use",
      },
    });
  });

  it("shows held text that is not a call, and streams other text at once", async () => {
    script = [
      () => ({
        sse: sse(
          { choices: [{ delta: { content: '{"name": "rm", ' } }] },
          { choices: [{ delta: { content: '"arguments": {}}' }, finish_reason: "stop" }] },
        ),
      }),
      () => ({
        sse: sse(
          { choices: [{ delta: { content: "```" } }] },
          { choices: [{ delta: { content: "python\n" } }] },
          { choices: [{ delta: { content: "print(1)\n```" }, finish_reason: "stop" }] },
        ),
      }),
    ];
    const unknown = await collect(client());
    expect(unknown.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: '{"name": "rm", "arguments": {}}' },
    ]);
    expect(unknown.at(-1)).toMatchObject({ response: { stopReason: "end_turn" } });

    const code = await collect(client());
    expect(code.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "```python\n" },
      { type: "text_delta", text: "print(1)\n```" },
    ]);
  });

  it("reads calls between prose in lines mode, set per model in models.json", async () => {
    const config = {
      providers: { fake: { type: "openai-compatible" as const, baseUrl: url, local: true } },
      models: { "fake/qwen": { textToolCalls: "lines" as const } },
    };
    const model = await resolveModel("fake/qwen", config).create({});
    const reply = [
      "Sure, I'll list the files.\n\n",
      '  {"name": "read_file", "arguments": {"path": "README.md"}}\n\n',
      "After reading the README, I'll list the files.",
    ];
    script = [
      () => ({
        sse: sse(...reply.map((content) => ({ choices: [{ delta: { content } }] })), {
          choices: [{ delta: {}, finish_reason: "stop" }],
        }),
      }),
    ];
    const events: ModelEvent[] = [];
    for await (const e of model.stream(request())) events.push(e);
    const shown = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(shown).not.toContain('"name"');
    expect(shown).toContain("Sure, I'll list the files.");
    expect(shown).toContain("After reading the README");
    expect(events.at(-1)).toMatchObject({
      response: {
        content: [
          {
            type: "text",
            text: "Sure, I'll list the files.\n\nAfter reading the README, I'll list the files.",
          },
          { type: "tool_use", name: "read_file", input: { path: "README.md" } },
        ],
        stopReason: "tool_use",
      },
    });

    // The default (whole) mode keeps this reply as text.
    script = [
      () => ({
        sse: sse({ choices: [{ delta: { content: reply.join("") }, finish_reason: "stop" }] }),
      }),
    ];
    expect((await collect(client())).at(-1)).toMatchObject({
      response: { content: [{ type: "text" }], stopReason: "end_turn" },
    });
  });

  it("runs a whole Garuda turn against a local server", async () => {
    const root = join(base, "root");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "a.js"), "export const a = 1;\n");
    script = [
      () => ({
        sse: sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "r1",
                    function: { name: "read_file", arguments: '{"path":"a.js"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      }),
      (body) => {
        const messages = body.messages as { role: string; content: string }[];
        expect(messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "r1" });
        expect(messages.at(-1)?.content).toContain("export const a = 1;");
        return {
          sse: sse({ choices: [{ delta: { content: "a is 1." }, finish_reason: "stop" }] }),
        };
      },
    ];
    const resolved = resolveModel("local/m", {
      providers: { local: { type: "openai-compatible", baseUrl: url, local: true } },
      models: { "local/m": { contextWindow: 16384 } },
    });
    const runtime = await Runtime.create({
      root,
      modelId: resolved.spec,
      model: () => resolved.create(),
      modelInfo: resolved.info,
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
    });
    const result = await runtime.runTurn("what is a?", AbortSignal.timeout(10_000));
    expect(result).toMatchObject({ stopReason: "done", steps: 2 });
    expect(runtime.limits.contextWindow).toBe(16384);
    expect(runtime.session?.costUsd).toBe(0);
  });
});
