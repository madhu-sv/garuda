import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime, type RuntimeOptions } from "../src/app/runtime.js";
import { usageSummary } from "../src/cli/chat/commands.js";
import { sessionMarkdown } from "../src/cli/export.js";
import { assistantLine } from "../src/cli/jsonOutput.js";
import { transcript, trimOldToolOutputs } from "../src/context/compact.js";
import { runAgent } from "../src/loop/runAgent.js";
import { fromWireMessage, toWireMessage, toWireParams } from "../src/model/anthropic.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { toWireMessages } from "../src/model/openaiCompatible.js";
import { costOf } from "../src/model/pricing.js";
import type {
  AssistantBlock,
  Message,
  ServerToolResultBlock,
  ServerToolUseBlock,
} from "../src/model/types.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../src/permissions/types.js";
import { Redactor } from "../src/session/redact.js";
import { resumeSession } from "../src/session/resume.js";
import { createSession } from "../src/session/session.js";
import { FileSessionStore, MemoryJournal } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createWebSearchTool } from "../src/tools/webSearch.js";
import { loadSearchConfig, type SearchConfig, saveSearchUse } from "../src/web/search.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-claudesearch-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const signal = () => new AbortController().signal;

function write(top: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const file = join(top, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

// The API's blocks, as the SDK gives them.
const WIRE_USE = {
  type: "server_tool_use",
  id: "srvtoolu_1",
  name: "web_search",
  input: { query: "vitest 5 release notes" },
  caller: { type: "direct" },
};
const WIRE_RESULT = {
  type: "web_search_tool_result",
  tool_use_id: "srvtoolu_1",
  caller: { type: "direct" },
  content: [
    {
      type: "web_search_result",
      url: "https://vitest.dev/blog/vitest-5",
      title: "Vitest 5 is out",
      encrypted_content: "Eqg-ENCRYPTED-sk-ant-abcdefghijklmnopqrstuv",
      page_age: "2 days ago",
    },
    {
      type: "web_search_result",
      url: "https://github.com/vitest-dev/vitest/releases",
      title: "Releases",
      encrypted_content: "Eqg-TWO",
      page_age: null,
    },
  ],
};
const WIRE_CITATION = {
  type: "web_search_result_location",
  url: "https://vitest.dev/blog/vitest-5",
  title: "Vitest 5 is out",
  encrypted_index: "Eo8-INDEX",
  cited_text: "Vitest 5 drops Node 18.",
};

const useBlock: ServerToolUseBlock = {
  type: "server_tool_use",
  id: "srvtoolu_1",
  name: "web_search",
  input: { query: "vitest 5 release notes" },
  wire: WIRE_USE,
};
const resultBlock: ServerToolResultBlock = {
  type: "server_tool_result",
  toolUseId: "srvtoolu_1",
  name: "web_search",
  results: [
    { title: "Vitest 5 is out", url: "https://vitest.dev/blog/vitest-5", age: "2 days ago" },
    { title: "Releases", url: "https://github.com/vitest-dev/vitest/releases" },
  ],
  wire: WIRE_RESULT,
};
const citedText: AssistantBlock = {
  type: "text",
  text: "Vitest 5 drops Node 18.",
  citations: [WIRE_CITATION],
};

describe("Claude's web search: the Anthropic adapter (0.6)", () => {
  it("sends the server tool after the client tools, with the cache mark on the last one", () => {
    const params = toWireParams("claude-sonnet-5", {
      system: "s",
      messages: [{ role: "user", content: [text("hi")] }],
      tools: [{ name: "read_file", description: "d", inputSchema: {} }],
      serverTools: [{ type: "web_search", maxUses: 3, blockedDomains: ["example.com"] }],
      maxTokens: 100,
    });
    expect(params.tools).toEqual([
      { name: "read_file", description: "d", input_schema: { type: "object" } },
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
        blocked_domains: ["example.com"],
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("reads search blocks, citations, pause_turn and the search count; sends them back unchanged", () => {
    const message = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [
        { type: "text", text: "I will search.", citations: null },
        WIRE_USE,
        WIRE_RESULT,
        { type: "text", text: "Vitest 5 drops Node 18.", citations: [WIRE_CITATION] },
      ],
      stop_reason: "pause_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
      },
    } as unknown as Anthropic.Messages.Message;
    const response = fromWireMessage(message);
    expect(response.stopReason).toBe("pause_turn");
    expect(response.usage.webSearches).toBe(1);
    expect(response.content).toEqual([
      { type: "text", text: "I will search." },
      useBlock,
      resultBlock,
      citedText,
    ]);
    const wire = toWireMessage({ role: "assistant", content: response.content });
    expect(wire.content).toEqual([
      { type: "text", text: "I will search." },
      WIRE_USE,
      WIRE_RESULT,
      { type: "text", text: "Vitest 5 drops Node 18.", citations: [WIRE_CITATION] },
    ]);
    // The cache mark on the last block never changes the stored block.
    const params = toWireParams("m", {
      system: "s",
      messages: [{ role: "assistant", content: [useBlock, resultBlock] }],
      tools: [],
      maxTokens: 1,
    });
    expect((params.messages[0]?.content as unknown[] | undefined)?.at(-1)).toMatchObject({
      cache_control: { type: "ephemeral" },
    });
    expect(resultBlock.wire).not.toHaveProperty("cache_control");
  });

  it("reads a search error", () => {
    const response = fromWireMessage({
      content: [
        WIRE_USE,
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Messages.Message);
    expect(response.content[1]).toMatchObject({ results: [], error: "max_uses_exceeded" });
  });

  it("costs $10 per 1,000 searches on top of the tokens", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
    expect(costOf(usage, price)).toBe(2);
    expect(costOf({ ...usage, webSearches: 3 }, price)).toBeCloseTo(2.03);
  });
});

describe("Claude's web search: the loop (0.6)", () => {
  const clientSearch = () =>
    new ToolRegistry([
      createWebSearchTool({
        config: {
          provider: "tavily",
          endpoint: new URL("https://api.tavily.com/search"),
          apiKey: "k",
          maxResults: 5,
        } as SearchConfig,
      }),
    ]);

  it("replaces the client web_search, goes on after pause_turn, and reports each search", async () => {
    const model = new FakeModelClient(
      [
        (request) => {
          expect(request.serverTools).toEqual([{ type: "web_search", maxUses: 5 }]);
          expect(request.tools.map((t) => t.name)).toEqual([]);
          return reply([useBlock], "pause_turn", {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            webSearches: 1,
          });
        },
        (request) => {
          // The paused message goes back as the last message.
          expect(request.messages.at(-1)?.role).toBe("assistant");
          return reply([resultBlock, citedText]);
        },
      ],
      { serverTools: ["web_search"] },
    );
    const session = createSession("/r", "s", new MemoryJournal());
    session.messages.push({ role: "user", content: [text("What is new in Vitest 5?")] });
    const events: string[] = [];
    const result = await runAgent(session, {
      model,
      tools: clientSearch(),
      system: "s",
      permissions: new AutoApprover("once") as never,
      serverTools: [{ type: "web_search", maxUses: 5 }],
      price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      onEvent: (e) => {
        if (e.type === "server_tool")
          events.push(`${e.call.name}:${e.result?.results.length ?? "-"}`);
      },
    });
    expect(result.stopReason).toBe("done");
    expect(result.steps).toBe(2);
    expect(result.usage.webSearches).toBe(1);
    expect(session.costUsd).toBeCloseTo(0.01);
    expect(events).toEqual(["web_search:-"]);
  });

  it("a model that cannot run server tools keeps the client web_search", async () => {
    const model = new FakeModelClient([
      (request) => {
        expect(request.serverTools).toBeUndefined();
        expect(request.tools.map((t) => t.name)).toEqual(["web_search"]);
        return reply([text("ok")]);
      },
    ]);
    const session = createSession("/r", "s");
    session.messages.push({ role: "user", content: [text("hi")] });
    await runAgent(session, {
      model,
      tools: clientSearch(),
      system: "s",
      permissions: new AutoApprover("once") as never,
      serverTools: [{ type: "web_search", maxUses: 5 }],
    });
    expect(model.remaining).toBe(0);
  });
});

describe("Claude's web search: other places (0.6)", () => {
  const history: Message[] = [
    { role: "user", content: [text("q")] },
    { role: "assistant", content: [text("Searching."), useBlock, resultBlock, citedText] },
    { role: "user", content: [text("next")] },
    { role: "assistant", content: [text("ok")] },
  ];

  it("old searches become titles and URLs in compaction; the transcript names them", () => {
    const { messages, savedChars } = trimOldToolOutputs(history, 3);
    expect(savedChars).toBeGreaterThan(0);
    expect(messages[1]?.content).toEqual([
      text("Searching."),
      {
        type: "text",
        text: '[Earlier web_search "vitest 5 release notes": 2 results]\n1. Vitest 5 is out — https://vitest.dev/blog/vitest-5\n2. Releases — https://github.com/vitest-dev/vitest/releases',
      },
      text("Vitest 5 drops Node 18."),
    ]);
    expect(messages[3]).toBe(history[3]);
    const lines = transcript(history);
    expect(lines).toContain('Agent called web_search (server) {"query":"vitest 5 release notes"}');
    expect(lines).toContain("1. Vitest 5 is out — https://vitest.dev/blog/vitest-5");
  });

  it("other providers get the results as text (after /models)", () => {
    const wire = toWireMessages("s", history);
    expect(wire[2]).toEqual({
      role: "assistant",
      content: expect.stringContaining("[Earlier web_search"),
    });
    expect(JSON.stringify(wire)).not.toContain("ENCRYPTED");
  });

  it("redaction keeps the encrypted content; a redacted block becomes text on resume", async () => {
    const redactor = new Redactor({});
    const kept = redactor.value(WIRE_RESULT);
    expect(kept.content[0]?.encrypted_content).toBe("Eqg-ENCRYPTED-sk-ant-abcdefghijklmnopqrstuv");

    const root = join(base, `r${n++}`);
    const store = new FileSessionStore(root, new Redactor({}));
    const journal = store.open("s1");
    const start = {
      root,
      version: "t",
      model: "m",
      executor: "host",
      isolation: "none",
      limits: { maxSteps: 1, tokenBudget: 1, contextWindow: 1 },
    };
    journal.write({ type: "start", sessionId: "s1", ...start });
    journal.write({ type: "user", message: history[0] as Message });
    // A query with a secret in it: the stored block is redacted, so it cannot go back as it is.
    const leaky: ServerToolUseBlock = {
      ...useBlock,
      input: { query: "sk-ant-abcdefghijklmnopqrstuvwxyz" },
      wire: { ...WIRE_USE, input: { query: "sk-ant-abcdefghijklmnopqrstuvwxyz" } },
    };
    journal.write({
      type: "assistant",
      step: 1,
      response: reply([leaky, resultBlock, citedText]),
    });
    journal.write({
      type: "assistant",
      step: 2,
      response: reply([useBlock, resultBlock]),
    });
    const session = await resumeSession({ store, root, sessionId: "s1", start });
    expect(session.messages[1]?.content.map((b) => b.type)).toEqual(["text", "text"]);
    expect(session.messages[2]?.content.map((b) => b.type)).toEqual([
      "server_tool_use",
      "server_tool_result",
    ]);
  });

  it("JSON output shows the API blocks and the search count, as Claude Code does", () => {
    const line = assistantLine(
      reply([useBlock, resultBlock, citedText], "end_turn", {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearches: 1,
      }),
      "claude-sonnet-5",
    ) as { message: { content: unknown[]; usage: Record<string, unknown> } };
    expect(line.message.content).toEqual([
      WIRE_USE,
      WIRE_RESULT,
      { type: "text", text: "Vitest 5 drops Node 18.", citations: [WIRE_CITATION] },
    ]);
    expect(line.message.usage.server_tool_use).toEqual({
      web_search_requests: 1,
      web_fetch_requests: 0,
    });
  });

  it("/export lists each search with its pages", () => {
    const md = sessionMarkdown(
      [
        { t: "2026-09-27T10:00:00Z", type: "user", message: history[0] as Message },
        {
          t: "2026-09-27T10:00:01Z",
          type: "assistant",
          step: 1,
          response: reply([useBlock, resultBlock, citedText]),
        },
      ],
      "s",
    );
    expect(md).toContain(
      "- `web_search (Claude) vitest 5 release notes` → 2 results\n  - [Vitest 5 is out](https://vitest.dev/blog/vitest-5)",
    );
  });
});

describe("Claude's web search: the config (0.6)", () => {
  const home = (json: unknown) => {
    const dir = join(base, `h${n++}`);
    write(dir, { ".garuda/search.json": JSON.stringify(json) });
    return dir;
  };

  it("a claude section turns it on; the fallback comes from the provider or the environment", async () => {
    expect(await loadSearchConfig(home({ claude: {} }), {})).toEqual({ claude: { maxUses: 5 } });
    const both = await loadSearchConfig(home({ claude: { maxUses: 2 } }), { TAVILY_API_KEY: "t" });
    expect(both.claude).toEqual({ maxUses: 2 });
    expect(both.config?.provider).toBe("tavily");
    const brave = await loadSearchConfig(
      home({ provider: "brave", claude: { allowedDomains: ["docs.python.org"] } }),
      { BRAVE_API_KEY: "b" },
    );
    expect(brave.claude).toEqual({ maxUses: 5, allowedDomains: ["docs.python.org"] });
    expect(brave.config?.provider).toBe("brave");
    // A broken fallback keeps Claude's search.
    const broken = await loadSearchConfig(home({ provider: "brave", claude: {} }), {});
    expect(broken.claude).toEqual({ maxUses: 5 });
    expect(broken.problem).toMatch(/BRAVE_API_KEY/);
  });

  it("checks the section", async () => {
    expect(
      (
        await loadSearchConfig(
          home({ claude: { allowedDomains: ["a.com"], blockedDomains: ["b.com"] } }),
          {},
        )
      ).problem,
    ).toMatch(/not both/);
    expect(
      (await loadSearchConfig(home({ claude: { allowedDomains: ["https://a.com"] } }), {})).problem,
    ).toMatch(/bare domain/);
    expect((await loadSearchConfig(home({}), {})).problem).toMatch(/name a "provider"/);
  });
});

describe("the saved search choice in search.json (0.14)", () => {
  it("loads use, also alone; saving keeps the other keys and never overwrites a broken file", async () => {
    const home = join(base, `use${n++}`);
    write(home, { ".garuda/search.json": JSON.stringify({ use: "off" }) });
    expect(await loadSearchConfig(home, {})).toEqual({ use: "off" });
    write(home, { ".garuda/search.json": JSON.stringify({ provider: "tavily", claude: {} }) });
    await saveSearchUse(home, "claude");
    const loaded = await loadSearchConfig(home, { TAVILY_API_KEY: "k" });
    expect(loaded.use).toBe("claude");
    expect(loaded.config?.provider).toBe("tavily");
    write(home, { ".garuda/search.json": "{ broken" });
    await expect(saveSearchUse(home, "off")).rejects.toThrow();
    expect(readFileSync(join(home, ".garuda", "search.json"), "utf8")).toBe("{ broken");
  });
});

describe("Claude's web search: the runtime (0.6)", () => {
  class Recorder implements Approver {
    readonly requests: ApprovalRequest[] = [];
    constructor(private readonly answers: ApprovalChoice[]) {}
    async ask(request: ApprovalRequest): Promise<ApprovalChoice> {
      this.requests.push(request);
      return this.answers.shift() ?? "deny";
    }
  }

  const SEARCH = {
    claude: { maxUses: 4 },
    config: {
      provider: "tavily" as const,
      endpoint: new URL("https://api.tavily.com/search"),
      apiKey: "k",
      maxResults: 5,
    },
  };

  async function runtimeFor(
    model: FakeModelClient,
    approver: Approver,
    extra: Partial<RuntimeOptions> = {},
    files: Record<string, string> = {},
  ) {
    const root = join(base, `p${n++}`);
    mkdirSync(root, { recursive: true });
    write(root, files);
    return Runtime.create({
      root,
      modelId: "claude-sonnet-5",
      model: async () => model,
      approver,
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      profiles: [],
      search: SEARCH,
      ...extra,
    });
  }

  it("asks once per session; yes sends the server tool instead of the client one", async () => {
    const seen: (string[] | undefined)[] = [];
    const answer = (request: Parameters<FakeModelClient["stream"]>[0]) => {
      seen.push(request.serverTools?.map((s) => `${s.type}:${s.maxUses}`));
      expect(request.tools.some((t) => t.name === "web_search")).toBe(
        request.serverTools === undefined,
      );
      return reply([text("ok")]);
    };
    const model = new FakeModelClient([answer, answer, answer], { serverTools: ["web_search"] });
    const approver = new Recorder(["session", "deny"]);
    const runtime = await runtimeFor(model, approver);
    expect(runtime.extras()).toContain("web_search: Claude + fallback");
    await runtime.runTurn("one", signal());
    await runtime.runTurn("two", signal());
    expect(approver.requests).toHaveLength(1);
    expect(approver.requests[0]).toMatchObject({
      title: "Claude's web search",
      question: "Allow Claude's web search?",
      choices: ["session", "deny"],
    });
    expect(approver.requests[0]?.preview).toContain("up to 4 searches per request");
    expect(approver.requests[0]?.preview).toContain("does not mean this task will search");
    expect(approver.requests[0]?.labels?.deny).toContain("other search provider");
    // A new session asks again; "no" falls back to the client web_search.
    runtime.newSession();
    await runtime.runTurn("three", signal());
    expect(approver.requests).toHaveLength(2);
    expect(seen).toEqual([["web_search:4"], ["web_search:4"], undefined]);
  });

  it("a saved choice (use) asks nothing; the first answer is saved; /search switches and saves (0.14)", async () => {
    const tools = (request: Parameters<FakeModelClient["stream"]>[0]) =>
      `${request.serverTools?.length ?? 0}/${request.tools.some((t) => t.name === "web_search")}`;
    const seen: string[] = [];
    const answer = (request: Parameters<FakeModelClient["stream"]>[0]) => {
      seen.push(tools(request));
      return reply([text("ok")]);
    };
    const run = async (use: "claude" | "provider" | "off") => {
      seen.length = 0;
      const approver = new Recorder([]);
      const model = new FakeModelClient([answer], { serverTools: ["web_search"] });
      const withUse = await runtimeFor(model, approver, { search: { ...SEARCH, use } });
      await withUse.runTurn("one", signal());
      return { asked: approver.requests.length, seen: seen[0] };
    };
    expect(await run("claude")).toEqual({ asked: 0, seen: "1/false" });
    expect(await run("provider")).toEqual({ asked: 0, seen: "0/true" });
    expect(await run("off")).toEqual({ asked: 0, seen: "0/false" });

    // No saved choice, a home folder: the answer goes into search.json.
    const home = join(base, `sh${n++}`);
    write(home, {
      ".garuda/search.json": JSON.stringify({ claude: { maxUses: 4 }, maxResults: 3 }),
    });
    const approver = new Recorder(["deny"]);
    const model = new FakeModelClient([answer, answer, answer], { serverTools: ["web_search"] });
    const runtime = await runtimeFor(model, approver, { search: { ...SEARCH, home } });
    await runtime.runTurn("one", signal());
    const saved = await loadSearchConfig(home, {});
    expect(saved.use).toBe("provider");
    expect(saved.claude?.maxUses).toBe(4);
    runtime.newSession();
    await runtime.runTurn("two", signal());
    expect(approver.requests).toHaveLength(1);

    // /search: this session, then saved.
    expect((await runtime.setSearch("off", false)).text).toMatch(/off for this session/);
    seen.length = 0;
    await runtime.runTurn("three", signal());
    expect(seen[0]).toBe("0/false");
    expect(runtime.searchStatus()).toMatch(/Web search now: off.*\n.*Saved choice: provider/s);
    expect((await runtime.setSearch("claude", true)).text).toMatch(/Saved in/);
    expect((await loadSearchConfig(home, {})).use).toBe("claude");
  });

  it("never asks for a model that cannot run it", async () => {
    const approver = new Recorder([]);
    const model = new FakeModelClient([reply([text("ok")])]);
    const runtime = await runtimeFor(model, approver);
    await runtime.runTurn("one", signal());
    expect(approver.requests).toHaveLength(0);
  });

  it("a custom agent whose tools allow web_search gets it too", async () => {
    const home = join(base, `ah${n++}`);
    write(home, {
      ".garuda/agents/researcher.md":
        "---\nname: researcher\ndescription: Looks things up.\ntools: Read, WebSearch\n---\nFind facts.\n",
    });
    const model = new FakeModelClient(
      [
        reply([toolUse("agent", { agent: "researcher", prompt: "Find the Vitest 5 news." }, "a1")]),
        (request) => {
          expect(request.system).toContain('You are "researcher"');
          expect(request.serverTools).toEqual([{ type: "web_search", maxUses: 4 }]);
          expect(request.tools.map((t) => t.name)).toEqual(["read_file"]);
          return reply([useBlock, resultBlock, text("Vitest 5 is out.")]);
        },
        (request) => {
          const result = JSON.stringify(request.messages.at(-1));
          expect(result).toContain("[calls: web_search (Claude) vitest 5 release notes]");
          return reply([text("Done.")]);
        },
      ],
      { serverTools: ["web_search"] },
    );
    const runtime = await runtimeFor(model, new Recorder(["session"]), {
      agents: {
        home,
        resolveModel: (spec) => ({
          spec,
          model: async () => model,
          info: { contextWindow: 200_000 },
        }),
      },
    });
    await runtime.runTurn("Research it", signal());
    expect(model.remaining).toBe(0);
  });

  it("/usage shows the searches", async () => {
    const model = new FakeModelClient(
      [
        reply([useBlock, resultBlock, text("ok")], "end_turn", {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          webSearches: 2,
        }),
      ],
      { serverTools: ["web_search"] },
    );
    const runtime = await runtimeFor(model, new Recorder(["session"]));
    await runtime.runTurn("one", signal());
    expect(usageSummary(runtime)).toContain("Claude web searches: 2 ($0.02)");
  });
});
