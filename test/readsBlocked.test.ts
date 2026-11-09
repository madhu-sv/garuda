import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { failureKind } from "../src/evals/runner.js";
import type { EvalResult } from "../src/evals/types.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import {
  findBlockedReads,
  NEEDED_MODE_DENY,
  readsHint,
  readsKeepHint,
  shortPath,
} from "../src/permissions/reads.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../src/permissions/types.js";
import { findOsSandbox } from "../src/sandbox/index.js";
import { FileTracker } from "../src/session/fileTracker.js";
import { createBashTool } from "../src/tools/bash.js";

/** T15 step 2 (docs/lld/reads.md): a blocked read gets a note, a question in chat, and an eval kind. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-blocked-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
function fakeHome(files: string[]): string {
  const home = join(base, `home-${++n}`);
  for (const f of files) {
    mkdirSync(join(home, f, ".."), { recursive: true });
    writeFileSync(join(home, f), "x\n");
  }
  return home;
}

/** An approver that answers with `choice` and records each question. */
function approver(choice: ApprovalChoice): Approver & { asked: ApprovalRequest[] } {
  const asked: ApprovalRequest[] = [];
  return {
    asked,
    ask: async (request) => {
      asked.push(request);
      return choice;
    },
  };
}

describe("finding blocked reads in a command's output", () => {
  const home = fakeHome(["notes/a.txt", "notes/b.txt", ".ssh/id", ".m2/settings.xml", "tools/x"]);
  const policy = {
    reads: { home, allow: [join(home, "tools")], hide: [] },
    writePaths: [join(home, "proj")],
    denyReadPaths: [join(home, ".ssh"), join(home, ".m2/settings.xml")],
  };

  it("names paths on error lines that exist and are outside the scope", () => {
    const out = [
      `head: ${home}/notes/a.txt: Operation not permitted`,
      `cat: ${home}/tools/x: Operation not permitted`,
      `open '${home}/.ssh/id': EPERM`,
      `Error: ENOENT: no such file or directory, open '${home}/.m2/settings.xml'`,
      `cat: ${home}/notes/missing.txt: No such file or directory`,
      `${home}/notes/b.txt is fine here`,
      `ls: ~/notes/a.txt: Operation not permitted`,
    ].join("\n");
    // tools/x is readable (another cause), .ssh is a secret (no question), missing.txt is missing,
    // the line without an error is not a block, and ~/ is the same path again.
    expect(findBlockedReads(out, policy)).toEqual([
      join(home, "notes/a.txt"),
      join(home, ".m2/settings.xml"),
    ]);
    expect(findBlockedReads(out, { ...policy, reads: undefined })).toEqual([]);
    expect(findBlockedReads(`ls: ${home}: Operation not permitted`, policy)).toEqual([home]);
  });

  it("the note names the paths and readPaths, and never suggests outside_sandbox", () => {
    const a = join(home, "notes/a.txt");
    expect(shortPath(a, home)).toBe("~/notes/a.txt");
    const note = readsHint([a], [], home);
    expect(note).toContain("The sandbox blocked reads of ~/notes/a.txt");
    expect(note).toContain('"sandbox.readPaths"');
    expect(note).toContain("do not use outside_sandbox");
    expect(readsHint([home], [], home)).toContain("may not read the whole home folder");
    expect(readsHint([a], [a], home)).toBe(
      "The user let commands read ~/notes/a.txt for this session. Run the command again.",
    );
    expect(readsKeepHint([a], home)).toContain('add "~/notes/a.txt" to "sandbox.readPaths"');
  });
});

describe("the bash tool's note, with the message macOS gives", () => {
  const home = fakeHome(["notes/a.txt"]);
  const root = join(home, "proj");
  mkdirSync(root, { recursive: true });
  // An executor that answers as Seatbelt does for a blocked read, on every system.
  const seatbeltLike = {
    name: "fake",
    isolation: "os" as const,
    run: async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted: false,
      durationMs: 1,
      stdout: { text: "", truncated: false, totalBytes: 0 },
      stderr: {
        text: `head: ${home}/notes/a.txt: Operation not permitted\n`,
        truncated: false,
        totalBytes: 0,
      },
    }),
    shutdown: () => {},
  };

  it("names the path and readPaths; the outside_sandbox advice does not appear", async () => {
    const permissions = new PermissionEngine({
      root,
      home,
      approver: approver("deny"),
      settings: parseSettings({ sandbox: { reads: "needed" } }),
      isolation: "os",
    });
    const bash = createBashTool();
    const result = await bash.run(
      { command: "head notes" },
      {
        root,
        signal: new AbortController().signal,
        permissions,
        files: new FileTracker(),
        executor: seatbeltLike as never,
      },
    );
    const text = bash.toText?.(result) ?? "";
    expect(text).toContain("The sandbox blocked reads of ~/notes/a.txt");
    expect(text).not.toContain("run it again with outside_sandbox: true");
    // In open mode the same output gets the general hint, as before (the negative control).
    const open = new PermissionEngine({ root, home, approver: approver("deny"), isolation: "os" });
    const before = await bash.run(
      { command: "head notes" },
      {
        root,
        signal: new AbortController().signal,
        permissions: open,
        files: new FileTracker(),
        executor: seatbeltLike as never,
      },
    );
    expect(bash.toText?.(before)).toContain("run it again with outside_sandbox: true");
  });
});

describe("the question in chat", () => {
  const home = fakeHome(["notes/a.txt"]);
  const root = join(home, "proj");
  mkdirSync(root, { recursive: true });
  const engine = (who: Approver, unattended = false) =>
    new PermissionEngine({
      root,
      home,
      approver: who,
      settings: parseSettings({ sandbox: { reads: "needed" } }),
      ...(unattended ? { unattended: { reason: "a job" } } : {}),
    });
  const signal = new AbortController().signal;
  const a = join(home, "notes/a.txt");

  it("a yes lets the next commands read the path, and asks once a session", async () => {
    const who = approver("session");
    const gate = engine(who);
    expect(gate.execPolicy(1_000).reads?.allow).not.toContain(a);
    expect(await gate.allowReads([a], signal)).toEqual([a]);
    expect(who.asked[0]).toMatchObject({
      tool: "sandbox_read",
      title: "Let commands read ~/notes/a.txt?",
      choices: ["session", "deny"],
    });
    expect(gate.execPolicy(1_000).reads?.allow).toContain(a);
    expect(await gate.allowReads([a], signal)).toEqual([a]);
    expect(who.asked).toHaveLength(1);
  });

  it("a no keeps it blocked; a job, the home folder itself and a hidden place get no question", async () => {
    const no = approver("deny");
    const gate = engine(no);
    expect(await gate.allowReads([a], signal)).toEqual([]);
    expect(gate.execPolicy(1_000).reads?.allow).not.toContain(a);
    const yes = approver("session");
    expect(await engine(yes, true).allowReads([a], signal)).toEqual([]);
    expect(await engine(yes).allowReads([home], signal)).toEqual([]);
    expect(yes.asked).toHaveLength(0);
  });

  it("a yes for one of the four mixed credential files brings it back", async () => {
    const file = join(home, NEEDED_MODE_DENY[0] ?? "");
    const gate = engine(approver("session"));
    expect(gate.execPolicy(1_000).denyReadPaths).toContain(file);
    await gate.allowReads([file], signal);
    expect(gate.execPolicy(1_000).denyReadPaths).not.toContain(file);
  });
});

describe("the eval failure kind", () => {
  const run = (over: Partial<EvalResult>): EvalResult => ({
    id: "t",
    title: "t",
    passed: false,
    stopReason: "done",
    steps: 3,
    tokens: 1,
    costUsd: 0,
    durationMs: 1,
    reason: "The check failed:\nx",
    ...over,
  });

  it("is 'sandbox' when a read was blocked; else as before", () => {
    expect(failureKind(run({ blockedReads: ["/h/x"] }))).toBe("sandbox");
    expect(failureKind(run({}))).toBe("check");
    expect(failureKind(run({ blockedReads: ["/h/x"], passed: true }))).toBeUndefined();
  });
});

// The bash tool with a real sandbox: Seatbelt on a Mac, bubblewrap on Linux.
const found = findOsSandbox();
const executor = "executor" in found ? found.executor : undefined;

describe.runIf(executor !== undefined)("the bash tool in this machine's sandbox", () => {
  const home = fakeHome(["notes/a.txt"]);
  const root = join(home, "proj");
  mkdirSync(root, { recursive: true });
  const bash = createBashTool();
  const call = async (who: Approver, command: string) => {
    const permissions = new PermissionEngine({
      root,
      home,
      approver: who,
      settings: parseSettings({ sandbox: { reads: "needed" } }),
      isolation: "os",
    });
    const context = {
      root,
      signal: new AbortController().signal,
      permissions,
      files: new FileTracker(),
      executor: executor as NonNullable<typeof executor>,
    };
    const first = await bash.run({ command }, context);
    const again = await bash.run({ command }, context);
    return {
      first: bash.toText?.(first) ?? "",
      again: bash.toText?.(again) ?? "",
      facts: bash.commandFacts?.(first),
    };
  };

  it("a blocked read gets the read note, not the outside_sandbox advice; a no keeps it blocked", async () => {
    const { first, facts } = await call(approver("deny"), `cat "${home}/notes/a.txt"`);
    expect(first).toContain("The sandbox blocked reads of ~/notes/a.txt");
    expect(first).not.toContain("run it again with outside_sandbox: true");
    expect(facts?.blockedReads).toEqual([join(home, "notes/a.txt")]);
  });

  it("a yes for the session: the same command works the next time", async () => {
    const { first, again } = await call(approver("session"), `cat "${home}/notes/a.txt"`);
    expect(first).toContain("The user let commands read ~/notes/a.txt for this session");
    expect(again).toContain("x");
    expect(again).not.toContain("blocked reads");
  });
});
