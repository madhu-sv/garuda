import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { AuditLogger } from "../src/audit/logger.js";
import { runCommand } from "../src/cli/chat/commands.js";
import type { Renderer } from "../src/cli/renderer.js";
import type { AgentEvent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import type { TeamPolicy } from "../src/permissions/policy.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { FileTracker } from "../src/session/fileTracker.js";
import { FileSessionStore } from "../src/session/store.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/types.js";

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

    const fileContent = readFileSync(join(root, ".garuda", "audit.jsonl"), "utf8");
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
    mkdirSync(join(root, ".garuda"), { recursive: true });
    writeFileSync(
      join(root, ".garuda", "audit.jsonl"),
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
    writeFileSync(
      join(root, ".garuda", "policy.json"),
      JSON.stringify({
        requireSandbox: true,
        disallowedCommands: ["rm -rf *", "git push *--force*"],
        denyPaths: ["**/.env*"],
      }),
    );

    const model = new FakeModelClient([reply([text("ok")])]);
    const store = new FileSessionStore(join(root, ".garuda", "sessions"));
    const runtime = await Runtime.create({
      root,
      modelId: "test-model",
      model,
      approver: new AutoApprover("once"),
      store,
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
    expect(out).toContain("Team Policy: active (.garuda/policy.json)");
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
