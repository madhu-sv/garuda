import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExecPolicy, Executor } from "../src/sandbox/types.js";

/**
 * The executor contract (N8). Every executor must pass this suite:
 * exit code, output, working folder, environment allowlist, output cap, timeout,
 * and process-tree kill on abort (Ctrl-C). 0.2 runs it against the OS sandbox too.
 */
export function executorContract(name: string, make: () => Executor): void {
  describe(`executor contract: ${name}`, () => {
    const executor = make();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "garuda-exec-")));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const policy = (over: Partial<ExecPolicy> = {}): ExecPolicy => ({
      root,
      readPaths: [root],
      writePaths: [root],
      network: false,
      envAllowlist: ["PATH", "HOME"],
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
      ...over,
    });

    it("declares a name and an isolation level", () => {
      expect(executor.name).toMatch(/^[a-z]+$/);
      expect(["none", "os", "container"]).toContain(executor.isolation);
    });

    it("returns stdout, stderr and the exit code", async () => {
      const r = await executor.run("echo out; echo err >&2; exit 3", policy());
      expect(r.exitCode).toBe(3);
      expect(r.stdout.text).toBe("out\n");
      expect(r.stderr.text).toBe("err\n");
      expect(r.timedOut).toBe(false);
      expect(r.stdout.truncated).toBe(false);
    });

    it("starts in the working root", async () => {
      const r = await executor.run("pwd", policy());
      expect(realpathSync(r.stdout.text.trim())).toBe(root);
    });

    it("passes only allowlisted environment variables", async () => {
      process.env.GARUDA_CONTRACT_SECRET = "hidden";
      process.env.GARUDA_CONTRACT_OK = "shown";
      try {
        const r = await executor.run(
          'echo "[$GARUDA_CONTRACT_SECRET][$GARUDA_CONTRACT_OK]"',
          policy({ envAllowlist: ["PATH", "GARUDA_CONTRACT_OK"] }),
        );
        expect(r.stdout.text.trim()).toBe("[][shown]");
      } finally {
        delete process.env.GARUDA_CONTRACT_SECRET;
        delete process.env.GARUDA_CONTRACT_OK;
      }
    });

    it("caps output and marks it as truncated", async () => {
      const r = await executor.run(
        "for i in $(seq 1 5000); do echo line-$i; done",
        policy({ maxOutputBytes: 1_000 }),
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout.truncated).toBe(true);
      expect(r.stdout.totalBytes).toBeGreaterThan(30_000);
      expect(r.stdout.text.length).toBeLessThan(1_200);
      // The start and the end both survive.
      expect(r.stdout.text.startsWith("line-1\n")).toBe(true);
      expect(r.stdout.text.trimEnd().endsWith("line-5000")).toBe(true);
    });

    it("kills the command at the timeout", async () => {
      const started = Date.now();
      const r = await executor.run("sleep 30", policy({ timeoutMs: 300 }));
      expect(r.timedOut).toBe(true);
      expect(r.exitCode).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("shutdown() kills every running command at once", async () => {
      const pidFile = join(root, "shutdown.pid");
      const run = executor.run(
        `sleep 30 & echo $! > "${pidFile}"; wait`,
        policy({ timeoutMs: 20_000 }),
      );
      await waitFor(() => readPid(pidFile) !== undefined);
      const child = readPid(pidFile) ?? 0;
      executor.shutdown();
      const r = await run;
      expect(r.exitCode).not.toBe(0);
      await waitFor(() => !isAlive(child));
    });

    it("kills the whole process tree on abort", async () => {
      const pidFile = join(root, "child.pid");
      const controller = new AbortController();
      const run = executor.run(
        `sleep 30 & echo $! > "${pidFile}"; wait`,
        policy({ timeoutMs: 20_000 }),
        { signal: controller.signal },
      );
      await waitFor(() => readPid(pidFile) !== undefined);
      const child = readPid(pidFile) ?? 0;
      expect(isAlive(child)).toBe(true);

      controller.abort();
      const r = await run;
      expect(r.aborted).toBe(true);
      await waitFor(() => !isAlive(child));
      expect(isAlive(child)).toBe(false);
    });
  });
}

function readPid(file: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
