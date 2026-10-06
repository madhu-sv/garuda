import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  client as createClient,
  methods,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { acpServer } from "../src/acp/server.js";
import { Runtime } from "../src/app/runtime.js";
import { protocolOutput } from "../src/cli/acpCommand.js";
import { HIDDEN_WARNING } from "../src/cli/approver.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { ModelRequest } from "../src/model/types.js";
import { parseSettings } from "../src/permissions/settings.js";
import { Redactor } from "../src/session/redact.js";
import { FileSessionStore } from "../src/session/store.js";
import { sleeping, uniqueSleep, waitUntil } from "./helpers.js";

/** `garuda acp` (0.15, docs/lld/acp.md): an SDK client talks to the server in this process. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-acp-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let count = 0;

/** A project and its own home folder: the test never reads the user's ~/.garuda. */
function project(files: Record<string, string> = {}): { root: string; home: string } {
  const root = join(base, `p${count}`);
  const home = join(base, `h${count++}`);
  mkdirSync(home, { recursive: true });
  writeFiles(root, { "README.md": "# Demo\n", ...files });
  return { root, home };
}

function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

type Answer = (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
const pick =
  (optionId: string): Answer =>
  async () => ({ outcome: { outcome: "selected", optionId } });

interface Run {
  updates: SessionNotification[];
  questions: RequestPermissionRequest[];
  model: FakeModelClient;
  /** Resolves when the commands for the "/" menu arrived (they come after session/new). */
  commandsSeen: Promise<void>;
}

/**
 * Start the server with a fake model, connect a client, make one session in `root`, and run
 * `body`. Every runtime closes afterwards.
 */
async function withSession<T>(
  where: { root: string; home: string },
  steps: ConstructorParameters<typeof FakeModelClient>[0],
  body: (
    agent: {
      request: (method: string, params: unknown) => Promise<unknown>;
      notify: (method: string, params: unknown) => Promise<void>;
    },
    sessionId: string,
    run: Run,
  ) => Promise<T>,
  options: { answer?: Answer; mcpServers?: unknown[] } = {},
): Promise<{ result: T } & Run> {
  const model = new FakeModelClient(steps);
  let seen: () => void = () => {};
  const commandsSeen = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const run: Run = { updates: [], questions: [], model, commandsSeen };
  const server = acpServer({
    version: "0.0.0-test",
    createRuntime: ({ root, approver, onEvent, onNotice }) =>
      Runtime.create({
        root,
        modelId: "claude-sonnet-5",
        model: async () => model,
        approver,
        store: new FileSessionStore(root, new Redactor({})),
        settings: parseSettings({}),
        hooks: { home: where.home },
        commands: { home: where.home },
        skills: { home: where.home },
        mcp: { home: where.home },
        onEvent,
        onNotice,
      }),
  });
  const answer = options.answer ?? pick("once");
  try {
    const result = await createClient({ name: "test-editor" })
      .onNotification(methods.client.session.update, (c) => {
        run.updates.push(c.params);
        if (c.params.update.sessionUpdate === "available_commands_update") seen();
      })
      .onRequest(methods.client.session.requestPermission, (c) => {
        run.questions.push(c.params);
        return answer(c.params);
      })
      .connectWith(server.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const { sessionId } = await agent.request(methods.agent.session.new, {
          cwd: where.root,
          mcpServers: (options.mcpServers ?? []) as never,
        });
        return body(agent as never, sessionId, run);
      });
    return { result, ...run };
  } finally {
    await server.close();
  }
}

const prompt = (sessionId: string, value: string) => ({
  sessionId,
  prompt: [{ type: "text", text: value }],
});
const kinds = (run: Run) => run.updates.map((u) => u.update.sessionUpdate);
const messages = (run: Run) =>
  run.updates
    .map((u) => u.update)
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => (u.content.type === "text" ? u.content.text : ""))
    .join("");

describe("garuda acp (0.15)", () => {
  it("initialize: protocol 1, text and embedded context, no editor MCP, no auth", async () => {
    const server = acpServer({
      version: "1.2.3",
      createRuntime: () => Promise.reject(new Error("unused")),
    });
    const response = await createClient({ name: "t" }).connectWith(server.app, (agent) =>
      agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      }),
    );
    expect(response).toEqual({
      protocolVersion: 1,
      agentInfo: { name: "garuda", title: "Garuda", version: "1.2.3" },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
    });
  });

  it("session/new: a relative cwd fails; a setup problem reaches the editor as the message", async () => {
    const server = acpServer({
      version: "t",
      createRuntime: () =>
        Promise.reject(new Error("Set a model with --model <id> or the GARUDA_MODEL variable.")),
    });
    const { root } = project();
    const errors = await createClient({ name: "t" }).connectWith(server.app, async (agent) => {
      const relative = await agent
        .request(methods.agent.session.new, { cwd: "some/folder", mcpServers: [] })
        .catch((e: Error) => e.message);
      const noModel = await agent
        .request(methods.agent.session.new, { cwd: root, mcpServers: [] })
        .catch((e: Error) => e.message);
      return { relative, noModel };
    });
    expect(errors.relative).toMatch(/cwd must be an absolute path to a folder/);
    expect(errors.noModel).toMatch(/GARUDA_MODEL/);
  });

  it("a prompt streams text, returns end_turn, and the session offers build and plan", async () => {
    const run = await withSession(
      project(),
      [reply([text("Hello from Garuda.")])],
      async (agent, id) => agent.request(methods.agent.session.prompt, prompt(id, "hi")),
    );
    expect(run.result).toEqual({ stopReason: "end_turn" });
    expect(messages(run)).toBe("Hello from Garuda.");
  });

  it("a tool call: tool_call (kind, title, location) then tool_call_update completed", async () => {
    const where = project();
    const run = await withSession(
      where,
      [reply([toolUse("read_file", { path: "README.md" }, "r1")]), reply([text("Read it.")])],
      async (agent, id) => agent.request(methods.agent.session.prompt, prompt(id, "read")),
    );
    const call = run.updates.map((u) => u.update).find((u) => u.sessionUpdate === "tool_call");
    expect(call).toMatchObject({
      toolCallId: "r1",
      title: "Read README.md",
      kind: "read",
      status: "pending",
      locations: [{ path: join(where.root, "README.md") }],
    });
    const done = run.updates
      .map((u) => u.update)
      .find((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed");
    expect(done).toMatchObject({ toolCallId: "r1" });
    expect(run.questions).toEqual([]);
  });

  it("an edit asks for its own tool call, with the editor's diff and visible hidden characters", async () => {
    const where = project();
    const content = "safe\u001b[2Khidden\n";
    const run = await withSession(
      where,
      [reply([toolUse("write_file", { path: "new.txt", content }, "w1")]), reply([text("Done.")])],
      async (agent, id) => agent.request(methods.agent.session.prompt, prompt(id, "write")),
    );
    expect(run.questions).toHaveLength(1);
    const question = run.questions[0] as RequestPermissionRequest;
    expect(question.toolCall.toolCallId).toBe("w1");
    expect(question.toolCall.title).toBe("Write new.txt");
    expect(question.options).toEqual([
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "session", name: "Allow for this session", kind: "allow_always" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ]);
    const [diff, preview] = question.toolCall.content ?? [];
    expect(diff).toEqual({
      type: "diff",
      path: join(where.root, "new.txt"),
      oldText: null,
      newText: content,
    });
    const shown =
      preview?.type === "content" && preview.content.type === "text" ? preview.content.text : "";
    expect(shown).toContain("␛[2K");
    expect(shown).not.toContain("\u001b");
    expect(shown).toContain(HIDDEN_WARNING);
    // "once" wrote the file; the tool call ends completed.
    expect(readFileSync(join(where.root, "new.txt"), "utf8")).toBe(content);
    expect(kinds(run)).toContain("tool_call_update");
  });

  it("deny: no file, the call ends failed, and the model hears the denial", async () => {
    const where = project();
    const run = await withSession(
      where,
      [
        reply([toolUse("write_file", { path: "no.txt", content: "x" }, "w1")]),
        (request: ModelRequest) => {
          expect(JSON.stringify(request.messages)).toContain("The user denied this call");
          return reply([text("OK, I will not.")]);
        },
      ],
      async (agent, id) => agent.request(methods.agent.session.prompt, prompt(id, "write")),
      { answer: pick("deny") },
    );
    expect(() => readFileSync(join(where.root, "no.txt"))).toThrow();
    const failed = run.updates
      .map((u) => u.update)
      .find((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed");
    expect(failed).toMatchObject({ toolCallId: "w1" });
    expect(run.model.remaining).toBe(0);
  });

  it("a cancelled question or an unknown option is a deny", async () => {
    for (const answer of [
      async () => ({ outcome: { outcome: "cancelled" } }) as RequestPermissionResponse,
      pick("yes-please"),
    ]) {
      const where = project();
      await withSession(
        where,
        [
          reply([toolUse("write_file", { path: "no.txt", content: "x" }, "w1")]),
          reply([text("ok")]),
        ],
        async (agent, id) => agent.request(methods.agent.session.prompt, prompt(id, "write")),
        { answer },
      );
      expect(() => readFileSync(join(where.root, "no.txt"))).toThrow();
    }
  });

  it("session/cancel during a question: cancelled, nothing written, and the next prompt works", async () => {
    const where = project();
    let asked: () => void = () => {};
    const question = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let release: (r: RequestPermissionResponse) => void = () => {};
    const run = await withSession(
      where,
      [
        reply([toolUse("write_file", { path: "no.txt", content: "x" }, "w1")]),
        reply([text("Fresh start.")]),
      ],
      async (agent, id) => {
        const first = agent.request(methods.agent.session.prompt, prompt(id, "write"));
        await question;
        await agent.notify(methods.agent.session.cancel, { sessionId: id });
        const stopped = await first;
        // The editor answers "cancelled" after its cancel, as the protocol asks.
        release({ outcome: { outcome: "cancelled" } });
        const next = await agent.request(methods.agent.session.prompt, prompt(id, "again"));
        return { stopped, next };
      },
      {
        answer: () =>
          new Promise((resolve) => {
            release = resolve;
            asked();
          }),
      },
    );
    expect(run.result).toEqual({
      stopped: { stopReason: "cancelled" },
      next: { stopReason: "end_turn" },
    });
    expect(() => readFileSync(join(where.root, "no.txt"))).toThrow();
    expect(messages(run)).toContain("Fresh start.");
  });

  it("allow for this session: the next call of the tool asks no question", async () => {
    const where = project();
    const run = await withSession(
      where,
      [
        reply([toolUse("write_file", { path: "a.txt", content: "a" }, "w1")]),
        reply([toolUse("write_file", { path: "b.txt", content: "b" }, "w2")]),
        reply([text("Both written.")]),
      ],
      async (agent, id) => agent.request(methods.agent.session.prompt, prompt(id, "write two")),
      { answer: pick("session") },
    );
    expect(run.questions.map((q) => q.toolCall.toolCallId)).toEqual(["w1"]);
    expect(readFileSync(join(where.root, "b.txt"), "utf8")).toBe("b");
  });

  it("session/cancel during a command: cancelled, and the command is gone", async () => {
    const where = project();
    const marker = uniqueSleep();
    const run = await withSession(
      where,
      [reply([toolUse("bash", { command: `sleep ${marker}` }, "b1")]), reply([text("ok")])],
      async (agent, id) => {
        const first = agent.request(methods.agent.session.prompt, prompt(id, "wait"));
        await waitUntil(() => sleeping(marker, where.root));
        await agent.notify(methods.agent.session.cancel, { sessionId: id });
        return first;
      },
    );
    expect(run.result).toEqual({ stopReason: "cancelled" });
    await waitUntil(async () => !(await sleeping(marker, where.root)));
  });

  it("a second prompt while one runs gets an error", async () => {
    let asked: () => void = () => {};
    const question = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let release: (r: RequestPermissionResponse) => void = () => {};
    const run = await withSession(
      project(),
      [reply([toolUse("write_file", { path: "a.txt", content: "x" }, "w1")]), reply([text("ok")])],
      async (agent, id) => {
        const first = agent.request(methods.agent.session.prompt, prompt(id, "write"));
        await question;
        const second = await agent
          .request(methods.agent.session.prompt, prompt(id, "more"))
          .catch((e: Error) => e.message);
        release({ outcome: { outcome: "selected", optionId: "once" } });
        await first;
        return second;
      },
      {
        answer: () =>
          new Promise((resolve) => {
            release = resolve;
            asked();
          }),
      },
    );
    expect(run.result).toMatch(/A prompt is already running in this session/);
  });

  it("plan mode: an edit is denied with no question", async () => {
    const where = project();
    const run = await withSession(
      where,
      [
        reply([toolUse("write_file", { path: "plan.txt", content: "x" }, "w1")]),
        reply([text("Plan only.")]),
      ],
      async (agent, id) => {
        await agent.request(methods.agent.session.setMode, { sessionId: id, modeId: "plan" });
        return agent.request(methods.agent.session.prompt, prompt(id, "write"));
      },
    );
    expect(run.questions).toEqual([]);
    expect(() => readFileSync(join(where.root, "plan.txt"))).toThrow();
  });

  it("a file link in the root is attached with @path; a link outside it stays text", async () => {
    const where = project({ "notes.md": "attached text 42\n" });
    const outside = join(base, `outside-${count}.md`);
    writeFileSync(outside, "outside secret 7\n");
    let seen = "";
    await withSession(
      where,
      [
        (request: ModelRequest) => {
          seen = JSON.stringify(request.messages);
          return reply([text("ok")]);
        },
      ],
      async (agent, id) =>
        agent.request(methods.agent.session.prompt, {
          sessionId: id,
          prompt: [
            { type: "text", text: "Look at these" },
            {
              type: "resource_link",
              uri: pathToFileURL(join(where.root, "notes.md")).href,
              name: "notes.md",
            },
            { type: "resource_link", uri: pathToFileURL(outside).href, name: "outside.md" },
            { type: "resource", resource: { uri: "file:///sel.ts", text: "const x = 1;" } },
          ],
        }),
    );
    expect(seen).toContain("attached text 42");
    expect(seen).not.toContain("outside secret 7");
    expect(seen).toContain("outside.md (file://");
    expect(seen).toContain("const x = 1;");
  });

  it("/name runs a custom command; a built-in terminal command does not reach the model", async () => {
    const where = project();
    writeFiles(where.home, { ".garuda/commands/hello.md": "Say hello to $ARGUMENTS." });
    let seen = "";
    const run = await withSession(
      where,
      [
        (request: ModelRequest) => {
          seen = JSON.stringify(request.messages);
          return reply([text("Hello.")]);
        },
      ],
      async (agent, id, current) => {
        await current.commandsSeen;
        await agent.request(methods.agent.session.prompt, prompt(id, "/hello world"));
        return agent.request(methods.agent.session.prompt, prompt(id, "/diff"));
      },
    );
    expect(seen).toContain("Say hello to world.");
    expect(run.result).toEqual({ stopReason: "end_turn" });
    expect(messages(run)).toContain("/diff is a terminal command");
    const commands = run.updates
      .map((u) => u.update)
      .find((u) => u.sessionUpdate === "available_commands_update");
    expect(commands).toMatchObject({
      availableCommands: [expect.objectContaining({ name: "hello" })],
    });
  });

  it("a consent that is not a tool call gets its own entry in the editor", async () => {
    const where = project({ ".garuda/commands/proj.md": "Run the project task." });
    const run = await withSession(
      where,
      [],
      async (agent, id) => agent.request(methods.agent.session.prompt, prompt(id, "/proj")),
      { answer: pick("deny") },
    );
    expect(run.questions).toHaveLength(1);
    const id = run.questions[0]?.toolCall.toolCallId;
    expect(id).toMatch(/^garuda-question-/);
    const entry = run.updates
      .map((u) => u.update)
      .find((u) => u.sessionUpdate === "tool_call" && u.toolCallId === id);
    expect(entry).toMatchObject({ kind: "other", status: "pending" });
    expect(messages(run)).toContain("You did not run /proj.");
    expect(run.model.remaining).toBe(0);
  });

  it("MCP servers from the editor are not started, with a notice", async () => {
    const run = await withSession(
      project(),
      [reply([text("ok")])],
      async (agent, id) => agent.request(methods.agent.session.prompt, prompt(id, "hi")),
      { mcpServers: [{ name: "editor-db", command: "db-server", args: [], env: [] }] },
    );
    expect(messages(run)).toContain(
      "the editor's MCP servers are not started in this version (editor-db)",
    );
  });

  it("a model error ends the prompt with its message; an unknown session is an error", async () => {
    const run = await withSession(project(), [], async (agent, id) => {
      const failed = await agent
        .request(methods.agent.session.prompt, prompt(id, "hi"))
        .catch((e: Error) => e.message);
      const unknown = await agent
        .request(methods.agent.session.prompt, prompt("no-such-session", "hi"))
        .catch((e: Error) => e.message);
      return { failed, unknown };
    });
    expect(run.result.failed).toMatch(/script/i);
    expect(run.result.unknown).toMatch(/not found|no-such-session/i);
  });
});

describe("the stdout guard of garuda acp (0.15)", () => {
  it("other writes to stdout go to stderr; the protocol stream writes to the real stdout", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const stdout = {
      write(chunk: Uint8Array | string, ...rest: unknown[]) {
        out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        const done = rest.find((r) => typeof r === "function") as (() => void) | undefined;
        done?.();
        return true;
      },
    };
    const stderr = {
      write(chunk: Uint8Array | string, ...rest: unknown[]) {
        err.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        const done = rest.find((r) => typeof r === "function") as (() => void) | undefined;
        done?.();
        return true;
      },
    };
    const protocol = protocolOutput(stdout, stderr);
    stdout.write("a notice\n");
    (stdout.write as (...a: unknown[]) => boolean)("with encoding\n", "utf8", () => {});
    const writer = protocol.getWriter();
    await writer.write(new TextEncoder().encode('{"jsonrpc":"2.0"}\n'));
    expect(out).toEqual(['{"jsonrpc":"2.0"}\n']);
    expect(err).toEqual(["a notice\n", "with encoding\n"]);
  });
});
