import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import {
  AuditLogger,
  auditDirFor,
  auditLineHash,
  checkpointPath,
  verifyAuditDir,
  verifyAuditFile,
} from "../src/audit/logger.js";
import { runCommand } from "../src/cli/chat/commands.js";
import type { Renderer } from "../src/cli/renderer.js";
import { HookRunner } from "../src/hooks/runner.js";
import type { AgentEvent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { parsePolicy, type TeamPolicy } from "../src/permissions/policy.js";
import { parseSettings } from "../src/permissions/settings.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { FileTracker } from "../src/session/fileTracker.js";
import { keepSecretForRedaction } from "../src/session/redact.js";
import { FileSessionStore } from "../src/session/store.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolContext, ToolHooks } from "../src/tools/types.js";

const base = mkdtempSync(join(tmpdir(), "garuda-audit-test-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const signal = new AbortController().signal;

class TestRenderer implements Renderer {
  messages: string[] = [];
  warns: string[] = [];
  errors: string[] = [];
  event(_event: AgentEvent): void {}
  info(msg: string): void {
    this.messages.push(msg);
  }
  warn(msg: string): void {
    this.warns.push(msg);
  }
  error(msg: string): void {
    this.errors.push(msg);
  }
}

describe("AuditLogger: core logging and querying", () => {
  it("logs structured events and parses them back", async () => {
    const root = join(base, "logger-basic");
    mkdirSync(root, { recursive: true });
    const logger = new AuditLogger(root);
    logger.setSessionId("sess-123");

    await logger.log({
      tool: "read_file",
      target: "src/main.ts",
      decision: "allow_readonly",
      allowed: true,
      risk: "low",
    });

    await logger.log({
      tool: "bash",
      target: "rm -rf /",
      decision: "deny_policy",
      allowed: false,
      reason: "Command disallowed by team policy.",
      risk: "critical",
    });

    const fileContent = readFileSync(logger.filePath, "utf8");
    const lines = fileContent.trim().split("\n");
    expect(lines).toHaveLength(2);

    const events = await logger.readEvents({ limit: 10 });
    expect(events).toHaveLength(2);
    // Most recent first:
    expect(events[0]?.tool).toBe("bash");
    expect(events[0]?.decision).toBe("deny_policy");
    expect(events[0]?.risk).toBe("critical");
    expect(events[0]?.sessionId).toBe("sess-123");

    expect(events[1]?.tool).toBe("read_file");
    expect(events[1]?.decision).toBe("allow_readonly");
  });

  it("filters events by denialsOnly, tool, and limit", async () => {
    const root = join(base, "logger-filter");
    mkdirSync(root, { recursive: true });
    const logger = new AuditLogger(root);

    await logger.log({ tool: "read_file", decision: "allow_readonly", allowed: true, risk: "low" });
    await logger.log({ tool: "bash", decision: "allow_sandbox", allowed: true, risk: "medium" });
    await logger.log({ tool: "bash", decision: "deny_user", allowed: false, risk: "high" });
    await logger.log({ tool: "edit_file", decision: "allow_rule", allowed: true, risk: "medium" });

    const denials = await logger.readEvents({ denialsOnly: true });
    expect(denials).toHaveLength(1);
    expect(denials[0]?.decision).toBe("deny_user");

    const bashOnly = await logger.readEvents({ tool: "bash" });
    expect(bashOnly).toHaveLength(2);

    const limited = await logger.readEvents({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it("computes accurate audit statistics", async () => {
    const root = join(base, "logger-stats");
    mkdirSync(root, { recursive: true });
    const logger = new AuditLogger(root);

    await logger.log({ tool: "read_file", decision: "allow_readonly", allowed: true, risk: "low" });
    await logger.log({ tool: "bash", decision: "allow_sandbox", allowed: true, risk: "medium" });
    await logger.log({ tool: "bash", decision: "deny_policy", allowed: false, risk: "critical" });
    await logger.log({ tool: "web_fetch", decision: "deny_user", allowed: false, risk: "high" });

    const stats = await logger.getStats();
    expect(stats.total).toBe(4);
    expect(stats.allowed).toBe(2);
    expect(stats.denied).toBe(2);
    expect(stats.policyBlocked).toBe(1);
    expect(stats.criticalCount).toBe(1);
  });

  it("gracefully tolerates corrupt lines in audit.jsonl", async () => {
    const root = join(base, "logger-corrupt");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "20261001T120000-1-aaaaaa.jsonl"),
      '{"id":"1","timestamp":"2026-10-01T12:00:00Z","tool":"read_file","allowed":true,"decision":"allow_readonly","risk":"low"}\ncorrupt json line\n{"id":"2","timestamp":"2026-10-01T12:00:01Z","tool":"bash","allowed":false,"decision":"deny_user","risk":"high"}\n',
    );

    const logger = new AuditLogger(root);
    const events = await logger.readEvents();
    expect(events).toHaveLength(2);
    expect(events[0]?.id).toBe("2");
    expect(events[1]?.id).toBe("1");
  });
});

describe("AuditLogger integration with PermissionEngine and ToolRegistry", () => {
  it("automatically logs permission decisions from PermissionEngine", async () => {
    const root = join(base, "engine-audit");
    mkdirSync(root, { recursive: true });
    const logger = new AuditLogger(root);
    const approver = new AutoApprover("deny");
    const policy: TeamPolicy = {
      disallowedCommands: ["rm -rf *"],
    };

    const engine = new PermissionEngine({
      root,
      approver,
      policy,
      auditLogger: logger,
    });

    // Policy block
    await engine.check(
      { tool: "bash", readOnly: false, info: { target: { kind: "command", command: "rm -rf /" } } },
      signal,
    );

    // Read only allow
    await engine.check(
      { tool: "read_file", readOnly: true, info: { target: { kind: "path", path: "src/a.ts" } } },
      signal,
    );

    // User deny
    await engine.check(
      {
        tool: "bash",
        readOnly: false,
        info: { target: { kind: "command", command: "echo outside", outsideSandbox: true } },
      },
      signal,
    );

    const events = await logger.readEvents();
    expect(events).toHaveLength(3);
    expect(events[0]?.decision).toBe("deny_user");
    expect(events[0]?.risk).toBe("high");

    expect(events[1]?.decision).toBe("allow_readonly");
    expect(events[1]?.risk).toBe("low");

    expect(events[2]?.decision).toBe("deny_policy");
    expect(events[2]?.risk).toBe("critical");
  });

  it("records tool execution duration and outcome in ToolRegistry", async () => {
    const root = join(base, "registry-audit");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "sample.txt"), "hello world");
    const logger = new AuditLogger(root);

    const registry = new ToolRegistry(defaultTools({ codeIndex: "lookup" }));
    const permissions = new PermissionEngine({
      root,
      approver: new AutoApprover("once"),
      auditLogger: logger,
    });

    const context: ToolContext = {
      root,
      signal,
      permissions,
      files: new FileTracker(),
      executor: new HostExecutor(),
      audit: logger,
    };

    const readCall = {
      type: "tool_use" as const,
      id: "call-1",
      name: "read_file",
      input: { path: "sample.txt" },
    };

    const outcome = await registry.execute(readCall, context);
    expect(outcome.isError).toBe(false);

    const events = await logger.readEvents();
    // One permission event + one tool execution event
    expect(events.length).toBeGreaterThanOrEqual(2);
    const execEvent = events.find((e) => e.decision === "executed");
    expect(execEvent).toBeDefined();
    expect(execEvent?.tool).toBe("read_file");
    expect(execEvent?.durationMs).toBeGreaterThanOrEqual(0);
    expect(execEvent?.isError).toBe(false);
  });
});

describe("/audit chat slash command", () => {
  it("renders team policy status and recent audit entries", async () => {
    const root = join(base, "audit-command");
    mkdirSync(join(root, ".garuda"), { recursive: true });
    const policy = {
      requireSandbox: true,
      disallowedCommands: ["rm -rf *", "git push *--force*"],
      denyPaths: ["**/.env*"],
    };

    const model = new FakeModelClient([reply([text("ok")])]);
    const store = new FileSessionStore(join(root, ".garuda", "sessions"));
    const runtime = await Runtime.create({
      root,
      modelId: "test-model",
      model,
      approver: new AutoApprover("once"),
      store,
      // Never the user's real ~/.garuda (merge gate: this test read real MCP and hook config).
      mcp: false,
      hooks: false,
      policy,
      policySources: ["/etc/garuda/policy.json"],
      audit: { dir: join(root, "audit") },
    });

    // Log some events
    await runtime.audit.log({
      tool: "read_file",
      target: "src/index.ts",
      decision: "allow_readonly",
      allowed: true,
      risk: "low",
    });
    await runtime.audit.log({
      tool: "bash",
      target: "rm -rf /",
      decision: "deny_policy",
      allowed: false,
      reason: "disallowed command",
      risk: "critical",
    });

    const renderer = new TestRenderer();
    const ctx = {
      runtime,
      renderer,
      sessionPath: (id: string) => join(root, id),
    };

    // 1. Regular /audit
    await runCommand("/audit", ctx);
    const out = renderer.messages.join("\n");
    expect(out).toContain("Team Policy: active (/etc/garuda/policy.json)");
    expect(out).toContain("Require Sandbox: enabled");
    expect(out).toContain("Disallowed Commands: 2 pattern(s)");
    expect(out).toContain("Recent Audit Events");
    expect(out).toContain("BLOCK (critical) bash · rm -rf /");
    expect(out).toContain("ALLOW (low) read_file · src/index.ts");

    // 2. /audit stats
    renderer.messages = [];
    await runCommand("/audit stats", ctx);
    const statsOut = renderer.messages.join("\n");
    expect(statsOut).toContain("Audit Statistics:");
    expect(statsOut).toContain("Total Events:      2");
    expect(statsOut).toContain("Policy Blocks:     1");

    // 3. /audit denials
    renderer.messages = [];
    await runCommand("/audit denials", ctx);
    const denialsOut = renderer.messages.join("\n");
    expect(denialsOut).toContain("Recent Security Denials / Policy Blocks");
    expect(denialsOut).toContain("BLOCK (critical) bash · rm -rf /");
    expect(denialsOut).not.toContain("read_file");
  });
});

describe("Audit log: hash chain, redaction, location, failures (merge gate)", () => {
  it("chains each line to the one before; verify names the first changed line", async () => {
    const dir = join(base, "chain");
    const logger = new AuditLogger(dir);
    for (const tool of ["read_file", "bash", "edit_file"]) {
      await logger.log({ tool, decision: "executed", allowed: true, risk: "low" });
    }
    expect(await verifyAuditFile(logger.filePath)).toEqual({ ok: true, lines: 3 });
    const lines = readFileSync(logger.filePath, "utf8").trim().split("\n");
    const first = JSON.parse(lines[0] as string);
    expect(first).toMatchObject({ seq: 1, prev: "0".repeat(64) });
    expect(JSON.parse(lines[1] as string).prev).toBe(first.hash);

    // Change one field of line 2: the chain breaks there.
    const changed = [...lines];
    changed[1] = (changed[1] as string).replace('"bash"', '"curl"');
    writeFileSync(logger.filePath, `${changed.join("\n")}\n`);
    expect(await verifyAuditFile(logger.filePath)).toEqual({
      ok: false,
      line: 2,
      why: "the hash does not match the line",
    });
    // Remove line 2: line 3 no longer follows line 1.
    writeFileSync(logger.filePath, `${[lines[0], lines[2]].join("\n")}\n`);
    expect((await verifyAuditFile(logger.filePath)).ok).toBe(false);
  });

  it("redacts secrets in targets and reasons, and writes into the given folder only", async () => {
    const dir = join(base, "redact");
    const env = { MY_API_KEY: "sk-test-1234567890abcdef" };
    const logger = new AuditLogger(dir, { env });
    await logger.logToolExecution({
      tool: "bash",
      target: {
        kind: "command",
        command:
          "curl -H 'Authorization: Bearer sk-test-1234567890abcdef' https://x.example token=abc123456789",
      },
      durationMs: 1,
      isError: false,
    });
    const text = readFileSync(logger.filePath, "utf8");
    expect(text).not.toContain("sk-test-1234567890abcdef");
    expect(text).not.toContain("abc123456789");
    expect(logger.filePath.startsWith(dir)).toBe(true);
  });

  it("keys the folder by project under ~/.garuda/audit", () => {
    expect(auditDirFor("/work/my app", "/home/u")).toMatch(
      /^\/home\/u\/\.garuda\/audit\/my_app-[0-9a-f]{8}$/,
    );
    expect(auditDirFor("/a/x", "/h")).not.toBe(auditDirFor("/b/x", "/h"));
  });

  it("a failed write: a notice once by default, an error when the policy makes the log mandatory", async () => {
    const blocker = join(base, "blocked-file");
    writeFileSync(blocker, "not a folder");
    const notices: string[] = [];
    const soft = new AuditLogger(join(blocker, "audit"), { onError: (m) => notices.push(m) });
    await soft.log({ tool: "a", decision: "executed", allowed: true, risk: "low" });
    await soft.log({ tool: "b", decision: "executed", allowed: true, risk: "low" });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/could not be written .* Garuda goes on without it\.$/);
    const hard = new AuditLogger(join(blocker, "audit"), { policy: { audit: { enabled: true } } });
    await expect(
      hard.log({ tool: "a", decision: "executed", allowed: true, risk: "low" }),
    ).rejects.toThrow(/could not be written/);
  });

  it("a runtime with no audit option writes no audit file", async () => {
    const root = join(base, "no-audit");
    mkdirSync(root, { recursive: true });
    const runtime = await Runtime.create({
      root,
      modelId: "test-model",
      model: new FakeModelClient([reply([text("ok")])]),
      approver: new AutoApprover("once"),
      store: new FileSessionStore(join(root, ".garuda", "sessions")),
      mcp: false,
      hooks: false,
    });
    await runtime.runTurn("hi", signal);
    expect(await runtime.audit.files()).toEqual([]);
  });
});

describe("Audit log: fixes from Garuda's audit review (0.14)", () => {
  let k = 0;
  const folder = () => {
    const dir = join(base, `review-${k++}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const call = (name: string, input: unknown) => ({
    type: "tool_use" as const,
    id: `c${k}`,
    name,
    input,
  });

  it("removes an env secret that matches no pattern, also one moved out of the environment", async () => {
    // The merge-gate test used values that the patterns remove anyway, so it could not see this.
    const env = { MY_API_KEY: "plainliteral-987654321" };
    const own = new AuditLogger(folder(), { env });
    await own.logToolExecution({
      tool: "bash",
      target: { kind: "command", command: "x --key plainliteral-987654321" },
      durationMs: 1,
      isError: false,
    });
    expect(readFileSync(own.filePath, "utf8")).not.toContain("plainliteral-987654321");

    // A provider key that Garuda took out of process.env before the logger was made.
    keepSecretForRedaction("GATEWAY_KEY_FOR_TEST", "gatewayliteral-5555555");
    const later = new AuditLogger(folder());
    await later.logToolExecution({
      tool: "bash",
      target: { kind: "command", command: "curl -H 'x-key: gatewayliteral-5555555' h" },
      durationMs: 1,
      isError: false,
    });
    expect(readFileSync(later.filePath, "utf8")).not.toContain("gatewayliteral-5555555");
  });

  it("reads nothing for limit 0, and keeps a file's last line apart when it has no newline", async () => {
    const dir = folder();
    const logger = new AuditLogger(dir);
    await logger.log({ tool: "a", decision: "executed", allowed: true, risk: "low" });
    expect(await logger.readEvents({ limit: 0 })).toEqual([]);
    // A crash cut the newline off the first file; a second file follows it.
    const text = readFileSync(logger.filePath, "utf8").trimEnd();
    writeFileSync(logger.filePath, text);
    writeFileSync(join(dir, "zz-later.jsonl"), `${text.replace('"tool":"a"', '"tool":"b"')}\n`);
    expect((await logger.readEvents()).map((e) => e.tool)).toEqual(["b", "a"]);
  });

  it("writes again after the folder was removed", async () => {
    const dir = join(folder(), "audit");
    const logger = new AuditLogger(dir);
    await logger.log({ tool: "a", decision: "executed", allowed: true, risk: "low" });
    rmSync(dir, { recursive: true, force: true });
    await logger.log({ tool: "b", decision: "executed", allowed: true, risk: "low" });
    await logger.log({ tool: "c", decision: "executed", allowed: true, risk: "low" });
    expect((await logger.readEvents()).map((e) => e.tool)).toEqual(["c"]);
  });

  it("classifies a protected path by the decision, not by .git in a rule's text", async () => {
    const root = folder();
    const logger = new AuditLogger(folder());
    const engine = new PermissionEngine({
      root,
      approver: new AutoApprover("once"),
      auditLogger: logger,
      settings: parseSettings({ permissions: { deny: ["edit_file(.github/**)"] } }),
    });
    const target = (path: string) => ({ target: { kind: "path" as const, path } });
    await engine.check(
      { tool: "edit_file", readOnly: false, info: target(".github/ci.yml") },
      signal,
    );
    await engine.check({ tool: "edit_file", readOnly: false, info: target(".git/config") }, signal);
    const events = (await logger.readEvents()).reverse();
    expect(events.map((e) => [e.decision, e.risk])).toEqual([
      ["deny_rule", "high"],
      ["deny_protected", "critical"],
    ]);
  });

  it("a mandatory log that cannot be written gives an error result; the call does not run", async () => {
    const root = folder();
    writeFileSync(join(root, "blocker"), "a file, not a folder");
    const logger = new AuditLogger(join(root, "blocker", "audit"), {
      policy: { audit: { enabled: true } },
    });
    const permissions = new PermissionEngine({
      root,
      approver: new AutoApprover("once"),
      auditLogger: logger,
    });
    const registry = new ToolRegistry(defaultTools());
    const outcome = await registry.execute(call("write_file", { path: "new.txt", content: "x" }), {
      root,
      signal,
      permissions,
      files: new FileTracker(),
      audit: logger,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toMatch(/could not be written.*so the call did not run/s);
    expect(() => readFileSync(join(root, "new.txt"))).toThrow();
  });

  it("records a call that a hook blocked, and one execution event when a later step fails", async () => {
    const root = folder();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const logger = new AuditLogger(folder());
    const permissions = new PermissionEngine({
      root,
      approver: new AutoApprover("once"),
      auditLogger: logger,
    });
    const registry = new ToolRegistry(defaultTools());
    const context = (hooks: ToolHooks): ToolContext => ({
      root,
      signal,
      permissions,
      files: new FileTracker(),
      audit: logger,
      hooks,
    });
    const blocked = await registry.execute(
      call("read_file", { path: "a.txt" }),
      context({ before: async () => "not today", after: async (_c, o) => o }),
    );
    expect(blocked.content).toBe("Blocked by a hook: not today");
    const failing = await registry.execute(
      call("read_file", { path: "a.txt" }),
      context({
        before: async () => undefined,
        after: async () => {
          throw new Error("post hook broke");
        },
      }),
    );
    expect(failing.isError).toBe(true);
    const events = (await logger.readEvents()).reverse();
    expect(events.map((e) => e.decision)).toEqual(["deny_hook", "allow_readonly", "executed"]);
    expect(events[0]).toMatchObject({ tool: "read_file", target: "a.txt", reason: "not today" });
    expect(events[2]).toMatchObject({ target: "a.txt" });
  });

  it("records each hook command, and the team policy refuses a hook command", async () => {
    const root = folder();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const logger = new AuditLogger(folder());
    const permissions = new PermissionEngine({
      root,
      approver: new AutoApprover("once"),
      policy: { disallowedCommands: ["echo refused-by-policy*"] },
      isolation: "none",
    });
    const hook = (command: string) => ({
      event: "preToolUse" as const,
      source: "project" as const,
      def: { command, tools: [], timeoutMs: 10_000, network: false },
      rules: [],
    });
    const marker = join(root, "ran.txt");
    const ok = new HookRunner({
      root,
      hooks: [hook("true")],
      executor: new HostExecutor(),
      permissions,
      audit: logger,
    });
    const hookCall = { tool: "read_file", input: { path: "a.txt" } };
    expect(await ok.before(hookCall, signal)).toBeUndefined();
    const refused = new HookRunner({
      root,
      hooks: [hook(`echo refused-by-policy > "${marker}"`)],
      executor: new HostExecutor(),
      permissions,
      audit: logger,
    });
    expect(await refused.before(hookCall, signal)).toMatch(/blocked the call/);
    expect(() => readFileSync(marker)).toThrow();
    const events = (await logger.readEvents()).reverse();
    expect(events.map((e) => [e.tool, e.decision])).toEqual([
      ["hook:preToolUse", "hook"],
      ["hook:preToolUse", "deny_policy"],
    ]);
  });
});

describe("Audit checkpoint (0.17, review T8)", () => {
  async function logged(dir: string, checkpoint: boolean, count = 3): Promise<AuditLogger> {
    const logger = new AuditLogger(dir, { checkpoint });
    for (let i = 0; i < count; i++) {
      await logger.log({ tool: `t${i}`, decision: "executed", allowed: true, risk: "low" });
    }
    return logger;
  }
  const cutLastLine = (file: string) => {
    const lines = readFileSync(file, "utf8").trim().split("\n");
    writeFileSync(file, `${lines.slice(0, -1).join("\n")}\n`);
  };

  it("finds lines cut from the end of a file", async () => {
    // Negative control: without the checkpoint, a cut tail still verifies.
    const plain = await logged(join(base, "cp-off"), false);
    cutLastLine(plain.filePath);
    const [off] = await verifyAuditDir(plain.dir);
    expect(off).toMatchObject({ checkpoint: false, verdict: { ok: true, lines: 2 } });

    const logger = await logged(join(base, "cp-on"), true);
    expect(await verifyAuditDir(logger.dir)).toEqual([
      { file: basename(logger.filePath), checkpoint: true, verdict: { ok: true, lines: 3 } },
    ]);
    cutLastLine(logger.filePath);
    const [cut] = await verifyAuditDir(logger.dir);
    expect(cut).toMatchObject({ checkpoint: true, verdict: { ok: false, line: 3 } });
    expect(JSON.stringify(cut)).toContain("lines were cut from the end");
  });

  it("finds a deleted file, and a rewritten line at the checkpoint", async () => {
    const logger = await logged(join(base, "cp-deleted"), true);
    rmSync(logger.filePath);
    expect(await verifyAuditDir(logger.dir)).toEqual([
      { file: basename(logger.filePath), missing: true },
    ]);

    // The cut tail with a forged last line: a valid chain, but not the checkpoint's line.
    const other = await logged(join(base, "cp-forged"), true, 2);
    const lines = readFileSync(other.filePath, "utf8").trim().split("\n");
    const second = JSON.parse(lines[1] as string);
    const { hash: _hash, ...body } = { ...second, tool: "forged" };
    const forged = { ...body, hash: auditLineHash(body) };
    writeFileSync(other.filePath, `${lines[0]}\n${JSON.stringify(forged)}\n`);
    const [result] = await verifyAuditDir(other.dir);
    expect(result).toMatchObject({ verdict: { ok: false, line: 2 } });
  });

  it("the checkpoint holds only seq and hash, private; the policy turns it on", async () => {
    const policy = parsePolicy({ audit: { checkpoint: true } });
    const logger = new AuditLogger(join(base, "cp-policy"), { policy });
    await logger.log({
      tool: "bash",
      target: "echo secret-target",
      decision: "executed",
      allowed: true,
      risk: "low",
    });
    const path = checkpointPath(logger.filePath);
    const text = readFileSync(path, "utf8");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["hash", "seq"]);
    expect(text).not.toContain("secret-target");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("/audit verify reports a cut tail with the checkpoint", async () => {
    const root = join(base, "cp-chat");
    mkdirSync(root, { recursive: true });
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: async () => new FakeModelClient([]),
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      policy: { audit: { checkpoint: true } },
      audit: { dir: join(base, "cp-chat-audit") },
      mcp: false,
      hooks: false,
      profiles: [],
    });
    for (const tool of ["a", "b"]) {
      await runtime.audit.log({ tool, decision: "executed", allowed: true, risk: "low" });
    }
    cutLastLine(runtime.audit.filePath);
    const renderer = new TestRenderer();
    await runCommand("/audit verify", {
      runtime,
      renderer,
      sessionPath: (id: string) => join(root, id),
    });
    const out = renderer.messages.join("\n");
    expect(out).toContain("BROKEN");
    expect(out).toContain("lines were cut from the end");
    await runtime.close();
  });
});
