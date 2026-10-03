import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolUseBlock } from "../src/model/types.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { MAX_LOG_LINE_CHARS, MAX_LOGS_CHARS } from "../src/sandbox/daemon.js";
import { HostExecutor } from "../src/sandbox/host.js";
import type { ExecPolicy } from "../src/sandbox/types.js";
import { createBashTool } from "../src/tools/bash.js";
import { processManagerTool } from "../src/tools/processManager.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { toolContext } from "./helpers.js";

const bashTool = createBashTool({ daemons: true });
const root = realpathSync(mkdtempSync(join(tmpdir(), "garuda-daemon-test-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const policy = (over: Partial<ExecPolicy> = {}): ExecPolicy => ({
  root,
  sandbox: false,
  writePaths: [root],
  denyWritePaths: [],
  denyReadPaths: [],
  network: false,
  envAllowlist: ["PATH", "HOME"],
  timeoutMs: 10_000,
  maxOutputBytes: 10_000,
  ...over,
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("DaemonManager in sandbox", () => {
  it("spawns a background process, tails logs, and kills it cleanly", async () => {
    const executor = new HostExecutor();
    const daemon = executor.daemons.spawn(
      'for i in $(seq 1 20); do echo "hello $i"; sleep 0.05; done',
      policy(),
    );

    expect(daemon.id).toMatch(/^daemon_\d+$/);
    expect(daemon.status).toBe("running");
    expect(daemon.pid).toBeTypeOf("number");

    // Wait until at least one log line is captured
    await waitFor(() => (executor.daemons.logs(daemon.id)?.length ?? 0) >= 1);
    const logs = executor.daemons.logs(daemon.id);
    expect(logs?.some((l) => l.includes("hello 1"))).toBe(true);

    const status = executor.daemons.get(daemon.id);
    expect(status?.status).toBe("running");
    expect(status?.uptimeMs).toBeGreaterThan(0);

    const killOutcome = executor.daemons.kill(daemon.id);
    expect(killOutcome.ok).toBe(true);

    await waitFor(() => executor.daemons.get(daemon.id)?.status === "stopped");
    expect(executor.daemons.get(daemon.id)?.status).toBe("stopped");

    executor.shutdown();
  });

  it("updates status to stopped when process exits naturally with code 0", async () => {
    const executor = new HostExecutor();
    const daemon = executor.daemons.spawn('echo "done quickly"; exit 0', policy());

    await waitFor(() => executor.daemons.get(daemon.id)?.status === "stopped");
    const status = executor.daemons.get(daemon.id);
    expect(status?.status).toBe("stopped");
    expect(status?.exitCode).toBe(0);

    const logs = executor.daemons.logs(daemon.id);
    expect(logs).toContain("[stdout] done quickly");
    executor.shutdown();
  });

  it("updates status to failed when process exits with non-zero code", async () => {
    const executor = new HostExecutor();
    const daemon = executor.daemons.spawn('echo "something went wrong" >&2; exit 42', policy());

    await waitFor(() => executor.daemons.get(daemon.id)?.status === "failed");
    const status = executor.daemons.get(daemon.id);
    expect(status?.status).toBe("failed");
    expect(status?.exitCode).toBe(42);

    const logs = executor.daemons.logs(daemon.id);
    expect(logs).toContain("[stderr] something went wrong");
    executor.shutdown();
  });

  it("shutdown() terminates all running background processes", async () => {
    const executor = new HostExecutor();
    const d1 = executor.daemons.spawn("sleep 30", policy());
    const d2 = executor.daemons.spawn("sleep 30", policy());

    expect(executor.daemons.get(d1.id)?.status).toBe("running");
    expect(executor.daemons.get(d2.id)?.status).toBe("running");

    executor.shutdown();

    await waitFor(() => executor.daemons.get(d1.id)?.status === "stopped");
    await waitFor(() => executor.daemons.get(d2.id)?.status === "stopped");
    expect(executor.daemons.get(d1.id)?.status).toBe("stopped");
    expect(executor.daemons.get(d2.id)?.status).toBe("stopped");
  });
});

describe("bash tool and process_manager integration", () => {
  it("starts daemon via bash tool and inspects/kills it with process_manager", async () => {
    const executor = new HostExecutor();
    const registry = new ToolRegistry([bashTool, processManagerTool]);
    const ctx = { ...toolContext(root), executor };

    let callId = 0;
    const call = (name: string, input: unknown) => {
      const block: ToolUseBlock = { type: "tool_use", id: `call_${++callId}`, name, input };
      return registry.execute(block, ctx);
    };

    // 1. Start daemon via bash(is_daemon: true)
    const bashResult = await call("bash", {
      command: 'for i in $(seq 1 30); do echo "server tick $i"; sleep 0.05; done',
      is_daemon: true,
    });

    expect(bashResult.isError).toBe(false);
    expect(bashResult.content).toContain("Daemon process started in background: daemon_");
    expect(bashResult.content).toContain("server tick");

    // 2. List daemons via process_manager(action: "list")
    const listResult = await call("process_manager", { action: "list" });
    expect(listResult.isError).toBe(false);
    expect(listResult.content).toContain("running");
    expect(listResult.content).toContain("server tick");

    // Extract daemonId
    const match = /\[(daemon_\d+)\]/.exec(listResult.content);
    expect(match).not.toBeNull();
    const daemonId = match?.[1] ?? "";
    expect(daemonId).not.toBe("");

    // 3. Check logs via process_manager(action: "logs")
    await waitFor(async () => {
      const logs = await call("process_manager", { action: "logs", daemonId });
      return logs.content.includes("server tick 1");
    });

    const logsResult = await call("process_manager", { action: "logs", daemonId, lines: 5 });
    expect(logsResult.isError).toBe(false);
    expect(logsResult.content).toContain("[stdout] server tick");

    // 4. Check status via process_manager(action: "status")
    const statusResult = await call("process_manager", { action: "status", daemonId });
    expect(statusResult.isError).toBe(false);
    expect(statusResult.content).toContain(`Daemon ID: ${daemonId}`);
    expect(statusResult.content).toContain("Status: running");

    // 5. Terminate daemon via process_manager(action: "kill")
    const killResult = await call("process_manager", { action: "kill", daemonId });
    expect(killResult.isError).toBe(false);
    expect(killResult.content).toContain(`Asked daemon process ${daemonId}`);

    // The status changes when the process has ended (0.14, review), not at once.
    const status = async () =>
      (await call("process_manager", { action: "status", daemonId })).content;
    await waitFor(async () => (await status()).includes("Status: stopped"));

    executor.shutdown();
  });

  it("handles errors gracefully in process_manager", async () => {
    const executor = new HostExecutor();
    const registry = new ToolRegistry([bashTool, processManagerTool]);
    const ctx = { ...toolContext(root), executor };

    const call = (name: string, input: unknown) => {
      const block: ToolUseBlock = { type: "tool_use", id: "c1", name, input };
      return registry.execute(block, ctx);
    };

    // Missing daemonId for logs
    const missingLogId = await call("process_manager", { action: "logs" });
    expect(missingLogId.content).toContain("daemonId is required");

    // Non-existent daemonId
    const nonExistent = await call("process_manager", { action: "status", daemonId: "daemon_999" });
    expect(nonExistent.content).toContain('No daemon process found with ID "daemon_999"');

    // Kill non-existent daemonId
    const nonExistentKill = await call("process_manager", {
      action: "kill",
      daemonId: "daemon_999",
    });
    expect(nonExistentKill.content).toContain("Daemon process not found");

    executor.shutdown();
  });

  it("filters logs by stream (stdout vs stderr)", async () => {
    const executor = new HostExecutor();
    const registry = new ToolRegistry([bashTool, processManagerTool]);
    const ctx = { ...toolContext(root), executor };

    let callId = 0;
    const call = (name: string, input: unknown) => {
      const block: ToolUseBlock = { type: "tool_use", id: `c_${++callId}`, name, input };
      return registry.execute(block, ctx);
    };

    const bashResult = await call("bash", {
      command: 'echo "hello stdout"; echo "hello stderr" >&2; sleep 5',
      is_daemon: true,
    });
    const match =
      /\[(daemon_\d+)\]/.exec(bashResult.content) ??
      /background: (daemon_\d+)/.exec(bashResult.content);
    expect(match).not.toBeNull();
    const daemonId = match?.[1] ?? "";
    expect(daemonId).not.toBe("");

    await waitFor(async () => {
      const logs = await call("process_manager", { action: "logs", daemonId });
      return logs.content.includes("hello stdout") && logs.content.includes("hello stderr");
    });

    const stdoutLogs = await call("process_manager", {
      action: "logs",
      daemonId,
      stream: "stdout",
    });
    expect(stdoutLogs.content).toContain("[stdout] hello stdout");
    expect(stdoutLogs.content).not.toContain("hello stderr");

    const stderrLogs = await call("process_manager", {
      action: "logs",
      daemonId,
      stream: "stderr",
    });
    expect(stderrLogs.content).toContain("[stderr] hello stderr");
    expect(stderrLogs.content).not.toContain("hello stdout");

    await call("process_manager", { action: "kill", daemonId });
    await waitFor(async () =>
      (await call("process_manager", { action: "status", daemonId })).content.includes(
        "Status: stopped",
      ),
    );

    // Repeated kill on already stopped daemon
    const secondKill = await call("process_manager", { action: "kill", daemonId });
    expect(secondKill.content).toContain("was already stopped");

    executor.shutdown();
  });

  it("supports multiple concurrent daemons with independent lifecycles", async () => {
    const executor = new HostExecutor();
    const registry = new ToolRegistry([bashTool, processManagerTool]);
    const ctx = { ...toolContext(root), executor };

    let callId = 0;
    const call = (name: string, input: unknown) => {
      const block: ToolUseBlock = { type: "tool_use", id: `multi_${++callId}`, name, input };
      return registry.execute(block, ctx);
    };

    const r1 = await call("bash", { command: "sleep 10", is_daemon: true });
    const r2 = await call("bash", { command: "sleep 10", is_daemon: true });

    const id1 = /background: (daemon_\d+)/.exec(r1.content)?.[1] ?? "";
    const id2 = /background: (daemon_\d+)/.exec(r2.content)?.[1] ?? "";
    expect(id1).not.toBe("");
    expect(id2).not.toBe("");
    expect(id1).not.toBe(id2);

    // Both running
    const s1 = await call("process_manager", { action: "status", daemonId: id1 });
    const s2 = await call("process_manager", { action: "status", daemonId: id2 });
    expect(s1.content).toContain("Status: running");
    expect(s2.content).toContain("Status: running");

    // Kill daemon 1 only
    await call("process_manager", { action: "kill", daemonId: id1 });
    await waitFor(async () =>
      (await call("process_manager", { action: "status", daemonId: id1 })).content.includes(
        "Status: stopped",
      ),
    );
    const s2After = await call("process_manager", { action: "status", daemonId: id2 });
    expect(s2After.content).toContain("Status: running");

    executor.shutdown();
    const s2Final = await call("process_manager", { action: "status", daemonId: id2 });
    expect(s2Final.content).toContain("Status: stopped");
  });
});

describe("daemons: bounded memory and shutdown (merge gate)", () => {
  it("cuts long lines, keeps text with no newline bounded, and caps what logs returns", async () => {
    const executor = new HostExecutor();
    // 200,000 characters with no newline, then a 10,000-character line.
    const daemon = executor.daemons.spawn(
      "head -c 200000 /dev/zero | tr '\\0' x; echo; head -c 10000 /dev/zero | tr '\\0' y; echo; sleep 5",
      policy(),
    );
    await waitFor(() =>
      (executor.daemons.logs(daemon.id, { lines: 0 }) ?? []).some((l) => l.includes("yyyy")),
    );
    const lines = executor.daemons.logs(daemon.id, { lines: 0 }) ?? [];
    for (const line of lines) expect(line.length).toBeLessThan(MAX_LOG_LINE_CHARS + 100);
    expect(lines.join("\n").length).toBeLessThanOrEqual(MAX_LOGS_CHARS + 200);
    expect(lines.some((l) => l.includes("more chars]"))).toBe(true);
    executor.daemons.shutdown();
  }, 15_000);

  it("Runtime.close stops running daemons, so a -p run can exit", async () => {
    const { Runtime } = await import("../src/app/runtime.js");
    const { FakeModelClient } = await import("../src/model/fake.js");
    const { AutoApprover } = await import("../src/permissions/autoApprover.js");
    const { parseSettings } = await import("../src/permissions/settings.js");
    const { FileSessionStore } = await import("../src/session/store.js");
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: new FakeModelClient([]),
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host", daemons: { enabled: true } }),
      mcp: false,
      hooks: false,
      profiles: [],
    });
    const daemons = runtime.executor.daemons;
    if (daemons === undefined) throw new Error("no daemons");
    const started = daemons.spawn("sleep 30", policy());
    expect(daemons.get(started.id)?.status).toBe("running");
    await runtime.close();
    expect(daemons.get(started.id)?.status).toBe("stopped");
    const pid = started.pid as number;
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  }, 15_000);

  it("daemons are off by default: bash has no is_daemon and refuses it", async () => {
    const plain = createBashTool();
    expect(
      JSON.stringify(plain.inputSchema.safeParse({ command: "x", is_daemon: true }).data),
    ).not.toContain("is_daemon");
    await expect(
      plain.run(
        { command: "true", is_daemon: true },
        toolContext(root, { executor: new HostExecutor() }),
      ),
    ).rejects.toThrow(/daemons\.enabled/);
  });
});

describe("process_manager kill is checked like a write (0.14, review)", () => {
  it("asks for kill, refuses it in plan mode, and never asks for list", async () => {
    const executor = new HostExecutor();
    const registry = new ToolRegistry([bashTool, processManagerTool]);
    const asked: string[] = [];
    let mode: "build" | "plan" = "build";
    const permissions = new PermissionEngine({
      root,
      approver: new AutoApprover((r) => {
        asked.push(r.preview);
        return "once";
      }),
      mode: () => mode,
    });
    const ctx = { ...toolContext(root, { permissions }), executor };
    let n = 0;
    const call = (name: string, input: unknown) =>
      registry.execute({ type: "tool_use", id: `pm_${++n}`, name, input } as ToolUseBlock, ctx);
    const started = await call("bash", { command: "sleep 10", is_daemon: true });
    const id = /background: (daemon_\d+)/.exec(started.content)?.[1] ?? "";
    asked.length = 0;

    expect((await call("process_manager", { action: "list" })).isError).toBe(false);
    expect(asked).toEqual([]);

    mode = "plan";
    const refused = await call("process_manager", { action: "kill", daemonId: id });
    expect(refused).toMatchObject({ isError: true, denied: true });

    mode = "build";
    const killed = await call("process_manager", { action: "kill", daemonId: id });
    expect(killed.isError).toBe(false);
    expect(asked).toEqual([expect.stringContaining(`Stop background process ${id}`)]);
    executor.shutdown();
  });
});
