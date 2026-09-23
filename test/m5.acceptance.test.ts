import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { PlainRenderer, summariseCall, summariseResult } from "../src/cli/renderer.js";
import { runRepl } from "../src/cli/repl.js";
import { runTurnInTerminal } from "../src/cli/turn.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import { Redactor } from "../src/session/redact.js";
import { FileSessionStore } from "../src/session/store.js";
import { writeFileAtomic } from "../src/tools/atomicWrite.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-m5-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Collects what the renderer writes. */
function sink() {
  let text = "";
  const stream = new Writable({
    write(chunk, _enc, done) {
      text += String(chunk);
      done();
    },
  });
  return { stream, text: () => text };
}

function project(name: string): string {
  const root = join(base, name);
  writeFiles(root, { "README.md": "# Demo\n", "src/a.js": "export const a = 1;\n" });
  return root;
}

function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

async function runtimeFor(root: string, model: FakeModelClient, onEvent?: (e: never) => void) {
  const out = sink();
  const err = sink();
  const renderer = new PlainRenderer({ out: out.stream, err: err.stream }, false);
  const runtime = await Runtime.create({
    root,
    modelId: "claude-sonnet-5",
    model: async () => model,
    approver: new AutoApprover("once"),
    store: new FileSessionStore(root, new Redactor({})),
    settings: parseSettings({}),
    onEvent: (event) => {
      renderer.event(event);
      onEvent?.(event as never);
    },
  });
  return { runtime, renderer, out, err };
}

const noExit = (): never => {
  throw new Error("exit");
};

describe("M5 acceptance", () => {
  it("chat mode (F2): several turns in one session, with commands, then exit", async () => {
    const root = project("chat");
    const model = new FakeModelClient([
      reply([text("Let me look. "), toolUse("glob", { pattern: "**/*.js" }, "g1")]),
      reply([text("There is one file: src/a.js.")]),
      (request) => {
        // The second turn sees the first one.
        expect(JSON.stringify(request.messages)).toContain("There is one file");
        return reply([text("It exports a = 1.")]);
      },
    ]);
    const { runtime, renderer, out, err } = await runtimeFor(root, model);
    const input = new PassThrough();
    input.end("What files are here?\n/usage\n\nWhat does it export?\n/session\n/exit\nnot read\n");

    await runRepl(runtime, { onInterrupt: () => {} }, renderer, (id) => `${id}.jsonl`, noExit, {
      input,
      output: sink().stream,
    });

    expect(model.remaining).toBe(0);
    expect(out.text()).toContain(
      "Let me look. \nThere is one file: src/a.js.\nIt exports a = 1.\n",
    );
    const log = err.text();
    expect(log).toContain("● glob **/*.js");
    expect(log).toContain("⎿ 1 result line(s)");
    expect(log).toMatch(/\[done · 2 step\(s\) · .* · context \d+% of 1\.0M · session/);
    expect(log).toMatch(/Session \d{8}-\d{6}-[0-9a-f]{4}: 30 tokens, \$0\.0/);
    expect(log).toMatch(/Session \d{8}-\d{6}-[0-9a-f]{4}\n\d{8}/);
    const files = readdirSync(join(root, ".garuda", "sessions"));
    expect(files).toHaveLength(1);
  });

  it("no session file until the first task, and /new starts a second one", async () => {
    const root = project("lazy");
    const model = new FakeModelClient([reply([text("one")]), reply([text("two")])]);
    const { runtime, renderer } = await runtimeFor(root, model);
    const input = new PassThrough();
    input.end("/help\n");
    await runRepl(runtime, { onInterrupt: () => {} }, renderer, (id) => id, noExit, {
      input,
      output: sink().stream,
    });
    expect(existsSync(join(root, ".garuda", "sessions"))).toBe(false);

    const again = new PassThrough();
    again.end("first\n/new\nsecond\n");
    await runRepl(runtime, { onInterrupt: () => {} }, renderer, (id) => id, noExit, {
      input: again,
      output: sink().stream,
    });
    expect(readdirSync(join(root, ".garuda", "sessions"))).toHaveLength(2);
  });

  it("Ctrl-C (F4): the first one stops the turn and kills the running command; the chat goes on", async () => {
    const root = project("ctrlc");
    const pidFile = join(root, "sleep.pid");
    const model = new FakeModelClient([
      reply([toolUse("bash", { command: `sleep 30 & echo $! > ${pidFile}; wait` }, "b1")]),
    ]);
    const { runtime, renderer, err } = await runtimeFor(root, model);

    const turn = runTurnInTerminal(runtime, { onInterrupt: () => {} }, renderer, "wait", noExit);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    process.emit("SIGINT");
    const outcome = await turn;

    expect(outcome.kind).toBe("interrupted");
    expect(err.text()).toContain("Stopping…");
    expect(err.text()).toContain("Turn stopped.");
    await waitFor(() => !alive(pid));
    // The session records the stop, and the next turn repairs the open tool call.
    const id = runtime.session?.id ?? "";
    const records = readFileSync(join(root, ".garuda", "sessions", `${id}.jsonl`), "utf8");
    expect(records).toContain('"stopReason":"interrupted"');
    expect(process.listenerCount("SIGINT")).toBe(0);
  });

  it("a second Ctrl-C during a turn exits at once", async () => {
    const root = project("ctrlc2");
    const pidFile = join(root, "sleep.pid");
    const model = new FakeModelClient([
      reply([toolUse("bash", { command: `sleep 30 & echo $! > ${pidFile}; wait` }, "b1")]),
    ]);
    const { runtime, renderer } = await runtimeFor(root, model);
    let exited = false;
    const exitNow = (): never => {
      exited = true;
      runtime.executor.shutdown();
      throw new Error("exit");
    };
    const turn = runTurnInTerminal(runtime, { onInterrupt: () => {} }, renderer, "wait", exitNow);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    // Hold the abort open: send both signals before the loop can react.
    const listeners = process.listeners("SIGINT");
    expect(listeners).toHaveLength(1);
    const stop = listeners[0] as () => void;
    stop();
    expect(() => stop()).toThrow("exit");
    expect(exited).toBe(true);
    await turn;
  });

  it("the renderer summarises calls and results in one line each (F3)", () => {
    const call = (name: string, input: unknown) => ({
      type: "tool_use" as const,
      id: "x",
      name,
      input,
    });
    expect(summariseCall(call("bash", { command: "pnpm test\necho more" }))).toBe("pnpm test");
    expect(summariseCall(call("grep", { pattern: "foo", path: "src" }))).toBe("/foo/ in src");
    expect(summariseCall(call("edit_file", { path: "a.ts" }))).toBe("a.ts");
    expect(summariseResult(call("read_file", {}), { content: "1\n2\n3", isError: false })).toBe(
      "3 line(s)",
    );
    expect(
      summariseResult(call("bash", {}), { content: "Exit code: 1\n<stdout>…", isError: false }),
    ).toBe("Exit code: 1");
    expect(
      summariseResult(call("edit_file", {}), {
        content: "Error: old_string was not found",
        isError: true,
      }),
    ).toBe("old_string was not found");
  });

  it("writes are atomic (F4): create-only, keep permissions, keep symbolic links, no temp files left", async () => {
    const dir = join(base, "atomic");
    writeFiles(dir, { "a.sh": "echo 1\n" });
    chmodSync(join(dir, "a.sh"), 0o755);
    symlinkSync("a.sh", join(dir, "link.sh"));

    await expect(
      writeFileAtomic(join(dir, "a.sh"), "x", { createOnly: true }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await writeFileAtomic(join(dir, "new.txt"), "new", { createOnly: true });
    await writeFileAtomic(join(dir, "link.sh"), "echo 2\n", { createOnly: false });

    expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(dir, "a.sh"), "utf8")).toBe("echo 2\n");
    expect(statSync(join(dir, "a.sh")).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(dir, "link.sh")).isSymbolicLink()).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes(".garuda-"))).toEqual([]);
  });
});

function alive(pid: number): boolean {
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
