import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { reply, text, toolUse } from "../src/model/fake.js";
import type { RunLimits } from "../src/session/records.js";
import { Redactor } from "../src/session/redact.js";
import { rebuildState, resumeSession } from "../src/session/resume.js";
import {
  addAssistantResponse,
  addSnapshot,
  addUserMessage,
  closeOpenToolCalls,
  createSession,
  undoTurn,
} from "../src/session/session.js";
import { FileSessionStore, newSessionId, parseRecords } from "../src/session/store.js";

const base = mkdtempSync(join(tmpdir(), "garuda-sessions-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const limits: RunLimits = { maxSteps: 50, tokenBudget: 1_000_000, contextWindow: 200_000 };
const start = (root: string) => ({
  root,
  version: "test",
  model: "m",
  executor: "host",
  isolation: "none",
  limits,
});

describe("session store (F24)", () => {
  it("writes one JSON line per record, private to the user", async () => {
    const root = join(base, "a");
    const store = new FileSessionStore(root, new Redactor({}));
    const id = newSessionId(new Date(2026, 8, 23, 20, 15, 0));
    expect(id).toMatch(/^20260923-201500-[0-9a-f]{4}$/);

    const session = createSession(root, id, store.open(id));
    session.journal?.write({ type: "start", sessionId: id, ...start(root) });
    addUserMessage(session, "hello");
    addAssistantResponse(session, reply([text("hi")]), 1, 0.001);

    const lines = readFileSync(store.path(id), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["start", "user", "assistant"]);
    expect(statSync(store.path(id)).mode & 0o777).toBe(0o600);
    expect(await store.read(id)).toHaveLength(3);
  });

  it("latest() picks the most recently written session", async () => {
    const root = join(base, "b");
    const store = new FileSessionStore(root, new Redactor({}));
    for (const id of ["one", "two"])
      store.open(id).write({ type: "end", stopReason: "done", steps: 0 });
    utimesSync(store.path("two"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    expect(await store.latest()).toBe("one");
    expect(await new FileSessionStore(join(base, "empty")).latest()).toBeUndefined();
  });

  it("skips a broken last line, but not a broken middle line", () => {
    const good = JSON.stringify({ type: "end", stopReason: "done", steps: 1, t: "x" });
    expect(parseRecords(`${good}\n{"type":"us`)).toHaveLength(1);
    expect(() => parseRecords(`{"bad\n${good}\n`)).toThrow(/line 1/);
  });
});

describe("secret redaction (N6)", () => {
  const redactor = new Redactor({ MY_SERVICE_TOKEN: "tok_live_1234567890", HOME: "/Users/me" });

  it("removes known key formats, secret assignments and secret env values", () => {
    const input = [
      "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
      "aws AKIAABCDEFGHIJKLMNOP",
      'password = "hunter2hunter2"',
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "value tok_live_1234567890 here",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
      "home /Users/me stays",
    ].join("\n");
    const out = redactor.text(input);
    expect(out).not.toMatch(/sk-ant-api03|AKIAABCD|hunter2|ghp_|tok_live|MIIE/);
    expect(out).toContain('password = "[REDACTED]"');
    expect(out).toContain("home /Users/me stays");
  });

  it("keeps code and numbers that only look like secret assignments (live: tokenBudget in a review)", () => {
    const code = [
      "tokenBudget: 20000000",
      '"tokenBudget": 1_000_000',
      "tokenBudget: z.number().int().positive().optional()",
      "apiKey: options.apiKey",
    ];
    for (const line of code) expect(redactor.text(line)).toBe(line);
    // Still secrets: a literal value, and a number under a password name.
    expect(redactor.text("token=m0_canary_secret_123456")).toBe("token=[REDACTED]");
    expect(redactor.text("password=12345678")).toBe("password=[REDACTED]");
    expect(redactor.text("secret = config.value1234567")).toBe("secret = [REDACTED]");
  });

  it("session files never hold the secret, though the session in memory does", async () => {
    const root = join(base, "c");
    const store = new FileSessionStore(root, redactor);
    const session = createSession(root, "s1", store.open("s1"));
    addUserMessage(session, "my token is tok_live_1234567890");
    expect(JSON.stringify(session.messages)).toContain("tok_live_1234567890");
    expect(readFileSync(store.path("s1"), "utf8")).not.toContain("tok_live_1234567890");
  });
});

describe("resume (F25)", () => {
  it("rebuilds messages, usage, cost and context size, then appends to the same file", async () => {
    const root = join(base, "d");
    const store = new FileSessionStore(root, new Redactor({}));
    const first = createSession(root, "s1", store.open("s1"));
    first.journal?.write({ type: "start", sessionId: "s1", ...start(root) });
    addUserMessage(first, "task one");
    addAssistantResponse(first, reply([text("done one")]), 1, 0.5);
    first.journal?.write({ type: "end", stopReason: "done", steps: 1 });

    const resumed = await resumeSession({ store, root, start: start(root) });
    expect(resumed.id).toBe("s1");
    expect(resumed.messages).toEqual(first.messages);
    expect(resumed.usage).toEqual(first.usage);
    expect(resumed.costUsd).toBeCloseTo(0.5);
    expect(resumed.contextTokens).toBe(first.contextTokens);
    addUserMessage(resumed, "task two");

    const records = await store.read("s1");
    expect(records.map((r) => r.type)).toEqual([
      "start",
      "user",
      "assistant",
      "end",
      "resume",
      "user",
    ]);
    expect(rebuildState(records).messages).toHaveLength(3);
  });

  it("closes tool calls that never got a result", () => {
    const session = createSession("/r", "s");
    addUserMessage(session, "go");
    addAssistantResponse(session, reply([toolUse("bash", { command: "sleep 99" }, "b1")]), 1, 0);
    expect(closeOpenToolCalls(session)).toBe(1);
    expect(session.messages.at(-1)?.content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "b1",
      isError: true,
    });
    expect(closeOpenToolCalls(session)).toBe(0);
  });

  it("forgets read_file deduplication when outputs leave the conversation (0.14, review)", () => {
    // Else read_file answers "it is still in the conversation" for an output that is gone.
    const session = createSession("/r", "s");
    const read = () => session.files.noteRead("/r/a.ts", "x", 0, 2000);
    expect(read()).toBe(false);
    expect(read()).toBe(true);
    addUserMessage(session, "go");
    addAssistantResponse(session, reply([toolUse("read_file", { path: "a.ts" }, "r1")]), 1, 0);
    closeOpenToolCalls(session);
    expect(read()).toBe(false);

    addSnapshot(session, "tree", "next", 0);
    addUserMessage(session, "next");
    expect(read()).toBe(true);
    expect(undoTurn(session, "after")).toBeDefined();
    expect(read()).toBe(false);
  });

  it("refuses a session from another project, and says when there is none", async () => {
    const root = join(base, "e");
    const store = new FileSessionStore(root, new Redactor({}));
    await expect(resumeSession({ store, root, start: start(root) })).rejects.toThrow(/no session/);
    store.open("x").write({ type: "start", sessionId: "x", ...start("/elsewhere") });
    await expect(resumeSession({ store, root, start: start(root) })).rejects.toThrow(/belongs to/);
  });

  it("refuses a session id that is a path (0.14, review)", async () => {
    const store = new FileSessionStore(join(base, "g"));
    expect(() => store.path("../../outside")).toThrow(/not a session id/);
    await expect(store.read("../x")).rejects.toThrow(/not a session id/);
    expect(store.path(newSessionId())).toMatch(/\.jsonl$/);
  });

  it("keeps a missing file error clear", async () => {
    const store = new FileSessionStore(join(base, "f"));
    writeFileSync(join(base, "placeholder"), "");
    await expect(store.read("nope")).rejects.toThrow(/ENOENT/);
  });
});
