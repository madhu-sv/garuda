import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createExecutor, HELPER_MISSING, StrictProfileError } from "../src/sandbox/index.js";
import { type Launch, ProcessExecutor, plain } from "../src/sandbox/process.js";
import { locateHelper, ReapError, Reaper, type Tracker } from "../src/sandbox/reaper.js";
import { SeatbeltExecutor, seatbeltProfile } from "../src/sandbox/seatbelt.js";
import type { ExecPolicy, Executor } from "../src/sandbox/types.js";
import { sleeping, uniqueSleep, waitUntil } from "./helpers.js";

/**
 * IPI-04 on macOS (0.17): processes that leave a command's process group. Seatbelt has no PID
 * namespace; the helper native/bin/garuda-reap finds them by their profile's markers and kills
 * them. The first part runs everywhere with a fake helper; the last part runs on macOS with the
 * real one.
 */

const temp = mkdtempSync(join(tmpdir(), "garuda-reaper-test-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const policy = (over: Partial<ExecPolicy> = {}): ExecPolicy => ({
  root: temp,
  sandbox: true,
  writePaths: [temp],
  denyWritePaths: [],
  denyReadPaths: [],
  network: false,
  envAllowlist: ["PATH"],
  timeoutMs: 10_000,
  maxOutputBytes: 10_000,
  ...over,
});

/** A fake helper: checks the markers like the real one, logs its arguments, and "kills" `n`. */
function fakeHelper(n: number, exitCode = 0): { path: string; log: string } {
  const dir = mkdtempSync(join(temp, "helper-"));
  const path = join(dir, "garuda-reap");
  const log = join(dir, "calls.log");
  writeFileSync(
    path,
    `#!/bin/sh\n[ -f "$1" ] && [ -f "$2" ] || { echo "garuda-reap: a marker file is missing" >&2; exit 3; }\necho "$1 $2" >> '${log}'\n[ ${exitCode} -eq 0 ] || { echo "garuda-reap: the process list failed" >&2; exit ${exitCode}; }\necho "killed ${n}"\n`,
  );
  chmodSync(path, 0o755);
  return { path, log };
}

describe("markers and the Seatbelt profile (0.17, IPI-04)", () => {
  it("each command gets two real marker files and three rules at the end of its profile", () => {
    const reaper = new Reaper(fakeHelper(0).path, temp);
    const tracker = reaper.track();
    const [denyA, allowB, denyWrite] = tracker.rules;
    const a = /literal "([^"]+)"/.exec(denyA ?? "")?.[1] ?? "";
    const b = /literal "([^"]+)"/.exec(allowB ?? "")?.[1] ?? "";
    expect(denyA).toMatch(/^\(deny file-read\* \(literal "/);
    expect(allowB).toMatch(/^\(allow file-read\* \(literal "/);
    // The command cannot delete its markers: the folder is read-only for it.
    expect(denyWrite).toMatch(/^\(deny file-write\* \(subpath "/);
    expect(existsSync(a) && existsSync(b)).toBe(true);
    expect(a).not.toBe(b);
    const profile = seatbeltProfile(policy({ writePaths: [temp] }), tracker.rules);
    // Last matching rule wins: the markers come after the writable temp folder.
    expect(profile.trimEnd().split("\n").slice(-3)).toEqual(tracker.rules);
    tracker.dispose();
    expect(existsSync(a) || existsSync(b)).toBe(false);
    reaper.close();
  });

  it("reap runs the helper with both markers, counts the kills and removes the markers", async () => {
    const helper = fakeHelper(2);
    const reaper = new Reaper(helper.path, temp);
    const tracker = reaper.track();
    const a = /literal "([^"]+)"/.exec(tracker.rules[0] ?? "")?.[1] ?? "";
    await expect(tracker.reap()).resolves.toBe(2);
    expect(readFileSync(helper.log, "utf8")).toContain(a);
    expect(existsSync(a)).toBe(false);
    // The synchronous form (shutdown).
    expect(reaper.track().reapSync()).toBe(2);
    reaper.close();
  });

  it("a failing helper is an error, and the markers still go away", async () => {
    const reaper = new Reaper(fakeHelper(0, 4).path, temp);
    const tracker = reaper.track();
    await expect(tracker.reap()).rejects.toThrow(ReapError);
    await expect(reaper.track().reap()).rejects.toThrow(/process list failed/);
    expect(() => reaper.track().reapSync()).toThrow(ReapError);
    reaper.close();
  });

  it("the markers folder exists only from the first command until close()", () => {
    const parent = mkdtempSync(join(temp, "parent-"));
    const reaper = new Reaper(fakeHelper(0).path, parent);
    expect(readdirSync(parent)).toEqual([]);
    reaper.track().dispose();
    expect(readdirSync(parent)).toHaveLength(1);
    reaper.close();
    expect(readdirSync(parent)).toEqual([]);
  });
});

/** A ProcessExecutor that tracks like Seatbelt, without a sandbox: for the wiring on any OS. */
class TrackingExecutor extends ProcessExecutor {
  readonly name = "tracking";
  readonly isolation = "none" as const;
  readonly launched: (Tracker | undefined)[] = [];
  constructor(private readonly reaper: Reaper) {
    super();
  }
  protected override track(p: ExecPolicy): Tracker | undefined {
    return p.sandbox ? this.reaper.track() : undefined;
  }
  protected override closeTracking(): void {
    this.reaper.close();
  }
  protected launch(argv: string[], _p: ExecPolicy, tracker?: Tracker): Launch {
    this.launched.push(tracker);
    return plain(argv);
  }
}

describe("the executor reaps after each command (0.17, IPI-04)", () => {
  it("run() reaps after the command and reports the kills; an unsandboxed command is not tracked", async () => {
    const helper = fakeHelper(1);
    const executor = new TrackingExecutor(new Reaper(helper.path, temp));
    const r = await executor.run("echo hi", policy());
    expect(r.stdout.text).toBe("hi\n");
    expect(r.reaped).toBe(1);
    expect(readFileSync(helper.log, "utf8").trim().split("\n")).toHaveLength(1);
    const plainRun = await executor.run("true", policy({ sandbox: false }));
    expect(plainRun.reaped).toBeUndefined();
    expect(executor.launched.at(-1)).toBeUndefined();
    executor.shutdown();
  });

  it("a helper failure reaches the result as reapProblem; the command result stays", async () => {
    const executor = new TrackingExecutor(new Reaper(fakeHelper(0, 4).path, temp));
    const r = await executor.run("exit 7", policy());
    expect(r.exitCode).toBe(7);
    expect(r.reapProblem).toMatch(/garuda-reap failed: garuda-reap: the process list failed/);
    executor.shutdown();
  });

  it("start(): the process's markers are reaped when it exits, and shutdown() reaps the rest", async () => {
    const helper = fakeHelper(0);
    const executor = new TrackingExecutor(new Reaper(helper.path, temp));
    const done = executor.start(["sh", "-c", "exit 0"], policy());
    const first = /literal "([^"]+)"/.exec(executor.launched[0]?.rules[0] ?? "")?.[1] ?? "";
    await new Promise<void>((resolve) => done.onExit(() => resolve()));
    // The reap after the exit is done when its markers are gone (it ran the helper once).
    await waitUntil(async () => !existsSync(first), 5_000);
    expect(readFileSync(helper.log, "utf8").trim().split("\n")).toHaveLength(1);
    executor.start(["sleep", "30"], policy());
    // shutdown() reaps the open tracker synchronously (an async reap may never finish at exit).
    executor.shutdown();
    expect(readFileSync(helper.log, "utf8").trim().split("\n")).toHaveLength(2);
  });
});

describe("selection without the helper (0.17, IPI-04)", () => {
  const found = (): { executor: Executor; warning: string } => ({
    executor: new SeatbeltExecutor(),
    warning: HELPER_MISSING,
  });

  it("the default profile warns", () => {
    const choice = createExecutor("auto", found);
    expect(choice.notice).toBe(HELPER_MISSING);
    expect(choice.executor.isolation).toBe("os");
  });

  it("the strict profile refuses", () => {
    expect(() => createExecutor("auto", found, true)).toThrow(StrictProfileError);
    expect(() => createExecutor("os", found, true)).toThrow(
      /requires the macOS helper garuda-reap/,
    );
  });
});

const helper = process.platform === "darwin" ? locateHelper() : undefined;

describe.runIf(helper !== undefined)("macOS: the real helper (0.17, IPI-04)", () => {
  const perlSetsid = (marker: string) =>
    `perl -MPOSIX -e 'if (fork() == 0) { POSIX::setsid(); open STDIN, "</dev/null"; open STDOUT, ">/dev/null"; open STDERR, ">/dev/null"; exec "sleep", "${marker}"; }'`;
  const nodeDetached = (marker: string) =>
    `'${process.execPath}' -e "require('child_process').spawn('sleep',['${marker}'],{detached:true,stdio:'ignore'}).unref()"`;

  for (const [name, command] of [
    ["fork and setsid (perl)", perlSetsid],
    ["posix_spawn with SETSID (Node's detached spawn)", nodeDetached],
  ] as const) {
    it(`kills a process that left the group: ${name} (control: without the helper it outlives the command)`, async () => {
      const root = mkdtempSync(join(temp, "mac-"));
      const control = uniqueSleep();
      const without = new SeatbeltExecutor();
      await without.run(command(control), policy({ root, writePaths: [root] }));
      await new Promise((done) => setTimeout(done, 500));
      const escaped = await sleeping(control, root);
      // It has no markers, so remove it by its unique duration.
      await without.run(`pkill -f '^sleep ${control}$' || true`, policy({ root, sandbox: false }));
      expect(escaped).toBe(true);

      const marker = uniqueSleep();
      const executor = new SeatbeltExecutor(new Reaper(helper as string, temp));
      const r = await executor.run(command(marker), policy({ root, writePaths: [root] }));
      expect(r.reapProblem).toBeUndefined();
      expect(r.reaped).toBeGreaterThanOrEqual(1);
      expect(await sleeping(marker, root)).toBe(false);
      executor.shutdown();
    }, 30_000);
  }

  it("never kills a process outside the command's profile", async () => {
    const root = mkdtempSync(join(temp, "mac-"));
    const marker = uniqueSleep();
    const outside = new SeatbeltExecutor();
    // Unsandboxed and started before: it must survive the scan.
    void outside.run(`sleep ${marker}`, policy({ root, sandbox: false, timeoutMs: 20_000 }));
    await waitUntil(async () => sleeping(marker, root), 5_000);
    const executor = new SeatbeltExecutor(new Reaper(helper as string, temp));
    const r = await executor.run("true", policy({ root, writePaths: [root] }));
    expect(r.reaped).toBeUndefined();
    expect(await sleeping(marker, root)).toBe(true);
    outside.shutdown();
    executor.shutdown();
  }, 30_000);
});
