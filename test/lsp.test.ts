import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { runCommand } from "../src/cli/chat/commands.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { approvalKeys } from "../src/cli/chat/ui.js";
import { buildSystemPrompt } from "../src/context/instructions.js";
import { LspClient, LspTimeoutError } from "../src/lsp/client.js";
import { loadLspConfig } from "../src/lsp/config.js";
import { formatDiagnostics, MAX_ERROR_LINES } from "../src/lsp/format.js";
import { INSTALL_TIMEOUT_MS, installCommand, installServer } from "../src/lsp/install.js";
import { LspManager } from "../src/lsp/manager.js";
import { discoverServer, isTypeScript7, languageOf, managedDir } from "../src/lsp/servers.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { ToolResultBlock } from "../src/model/types.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../src/permissions/types.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { findOsSandbox } from "../src/sandbox/index.js";
import type { ExecPolicy, ExecResult, Executor } from "../src/sandbox/types.js";
import { FileSessionStore } from "../src/session/store.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { toolContext } from "./helpers.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-lsp-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const FAKE = join(import.meta.dirname, "fixtures", "lspServer.mjs");
const REPO_BIN = join(import.meta.dirname, "..", "node_modules", ".bin");
const found = findOsSandbox();
const osExecutor = "executor" in found ? found.executor : undefined;

let count = 0;
function folder(name: string): string {
  const dir = join(base, `${name}-${++count}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A PATH folder with a fake server under the name of a real one. */
function fakeBin(mode: string, bin = "pyright-langserver"): string {
  const dir = folder("bin");
  const file = join(dir, bin);
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${mode} "$@"\n`);
  chmodSync(file, 0o755);
  return dir;
}

function program(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o755);
  return file;
}

class Recorder implements Approver {
  readonly requests: ApprovalRequest[] = [];
  constructor(private readonly answer: ApprovalChoice = "once") {}
  async ask(request: ApprovalRequest): Promise<ApprovalChoice> {
    this.requests.push(request);
    return this.answer;
  }
}

const signal = () => new AbortController().signal;

describe("languages and server discovery (0.4)", () => {
  it("maps file extensions to a language and an LSP languageId", () => {
    expect(languageOf("/r/a.ts")).toEqual({ language: "typescript", id: "typescript" });
    expect(languageOf("/r/A.TSX")).toEqual({ language: "typescript", id: "typescriptreact" });
    expect(languageOf("/r/a.mjs")).toEqual({ language: "typescript", id: "javascript" });
    expect(languageOf("/r/a.pyi")).toEqual({ language: "python", id: "python" });
    expect(languageOf("/r/A.java")).toBeUndefined();
    expect(languageOf("/r/Makefile")).toBeUndefined();
  });

  it("prefers the managed install, then PATH; it skips the project, relative entries and non-programs", () => {
    const home = folder("home");
    const root = folder("root");
    const inRoot = join(root, "node_modules", ".bin");
    program(inRoot, "pyright-langserver");
    const onPath = folder("path");
    program(onPath, "pyright-langserver");
    writeFileSync(join(onPath, "basedpyright-langserver"), "not executable");
    const path = ["relative/bin", inRoot, onPath].join(":");

    expect(discoverServer("python", { root, home, path })).toMatchObject({
      spec: { name: "pyright" },
      path: join(onPath, "pyright-langserver"),
      source: "path",
    });
    expect(discoverServer("python", { root, home, path: inRoot })).toBeUndefined();

    const managed = join(managedDir("python", home), "node_modules", ".bin");
    program(managed, "pyright-langserver");
    expect(discoverServer("python", { root, home, path })).toMatchObject({
      path: join(managed, "pyright-langserver"),
      source: "managed",
    });
  });

  it("uses tsc only from TypeScript 7 (it has --lsp); a pnpm shim counts too", () => {
    const dir = folder("ts");
    const bin = join(dir, "node_modules", ".bin");
    const tsc = program(bin, "tsc");
    mkdirSync(join(dir, "node_modules", "typescript"), { recursive: true });
    const pkg = join(dir, "node_modules", "typescript", "package.json");
    writeFileSync(pkg, JSON.stringify({ name: "typescript", version: "5.9.3" }));
    expect(isTypeScript7(tsc)).toBe(false);
    expect(discoverServer("typescript", { root: folder("r"), home: folder("h"), path: bin })).toBe(
      undefined,
    );
    writeFileSync(pkg, JSON.stringify({ name: "typescript", version: "7.0.2" }));
    expect(isTypeScript7(tsc)).toBe(true);
    expect(
      discoverServer("typescript", { root: folder("r"), home: folder("h"), path: bin }),
    ).toMatchObject({ spec: { name: "tsc", args: ["--lsp", "--stdio"] } });
  });
});

describe("the diagnostics text (0.4)", () => {
  it("shows errors only, sorted, first line of each message, with the code", () => {
    const text = formatDiagnostics("src/a.ts", "tsc", [
      { line: 9, character: 2, severity: 1, message: "Later.", code: 2322 },
      { line: 3, character: 5, severity: 2, message: "A warning." },
      { line: 3, character: 1, message: "No severity.\nmore", code: "x" },
    ]);
    expect(text).toBe(
      "2 errors in src/a.ts after this change (tsc):\n  3:1 No severity. [x]\n  9:2 Later. [2322]",
    );
    expect(
      formatDiagnostics("a.py", "pyright", [{ line: 1, character: 1, severity: 2, message: "w" }]),
    ).toBe("No errors in a.py (pyright).");
  });

  it("caps the list and cleans server text", () => {
    const many = Array.from({ length: MAX_ERROR_LINES + 3 }, (_, i) => ({
      line: i + 1,
      character: 1,
      severity: 1,
      message: i === 0 ? "\u001b[31mred\u001b[0m" : `e${i}`,
    }));
    const lines = formatDiagnostics("a.ts", "tsc", many).split("\n");
    expect(lines[0]).toBe(`${MAX_ERROR_LINES + 3} errors in a.ts after this change (tsc):`);
    expect(lines[1]).toBe("  1:1 red");
    expect(lines).toHaveLength(MAX_ERROR_LINES + 2);
    expect(lines.at(-1)).toBe("  … and 3 more.");
  });
});

describe("the user's lsp.json and the managed install (0.4)", () => {
  it("reads autoInstall from the home folder only; default off; bad keys fail", async () => {
    const home = folder("home");
    expect(await loadLspConfig(home)).toEqual({ autoInstall: false });
    mkdirSync(join(home, ".garuda"));
    writeFileSync(join(home, ".garuda", "lsp.json"), '{ "autoInstall": true }');
    expect(await loadLspConfig(home)).toEqual({ autoInstall: true });
    writeFileSync(join(home, ".garuda", "lsp.json"), '{ "autoinstall": true }');
    await expect(loadLspConfig(home)).rejects.toThrow(/lsp.json/);
  });

  it("runs a pinned npm install outside the sandbox, with no install scripts", async () => {
    expect(installCommand("python", "/h/.garuda/lsp/python")).toBe(
      "npm install --prefix /h/.garuda/lsp/python --ignore-scripts --no-audit --no-fund --loglevel=error pyright@1.1.414",
    );
    expect(installCommand("typescript", "/my home/x")).toContain("--prefix '/my home/x' ");
    expect(installCommand("typescript", "/x")).toMatch(/ typescript@7\.0\.2$/);

    const runs: { command: string; policy: ExecPolicy }[] = [];
    let exitCode = 0;
    const executor = {
      name: "fake",
      isolation: "os",
      async run(command: string, policy: ExecPolicy): Promise<ExecResult> {
        runs.push({ command, policy });
        const out = { text: "", truncated: false, totalBytes: 0 };
        return {
          exitCode,
          signal: null,
          stdout: out,
          stderr: { ...out, text: "npm error 404 pyright\nnpm error line 2" },
          timedOut: false,
          aborted: false,
          durationMs: 1,
        };
      },
      start: () => {
        throw new Error("no");
      },
      shutdown: () => {},
    } satisfies Executor;
    const home = folder("home");
    const ok = await installServer("python", { executor, home });
    expect(ok).toMatchObject({ ok: true, dir: managedDir("python", home) });
    expect(runs[0]?.policy).toMatchObject({
      root: managedDir("python", home),
      sandbox: false,
      network: true,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    expect(runs[0]?.policy.envAllowlist).toContain("HTTPS_PROXY");
    exitCode = 1;
    const failed = await installServer("python", { executor, home });
    expect(failed).toMatchObject({ ok: false, output: "npm error 404 pyright\nnpm error line 2" });
  });
});

describe("the LSP client against a fake server (0.4)", () => {
  const start = async (mode: string, timeouts = { firstTimeoutMs: 5_000, timeoutMs: 5_000 }) => {
    const root = folder("client");
    const executor = new HostExecutor();
    const process = executor.start([globalThis.process.execPath, FAKE, mode], {
      ...new PermissionEngine({ root, approver: new Recorder() }).serverPolicy(),
      sandbox: false,
    });
    const client = await LspClient.start(process, { root, ...timeouts }, signal());
    return { root, client, executor };
  };

  for (const mode of ["pull", "push", "push-old"]) {
    it(`gets diagnostics by ${mode}, for each new version of the file`, async () => {
      const { root, client, executor } = await start(mode);
      expect(client.usesPull).toBe(mode === "pull");
      const file = join(root, "a.py");
      expect(await client.diagnostics(file, "python", "ok\nx = ERROR\n", signal())).toEqual([
        { line: 2, character: 5, severity: 1, message: "error here\nsecond line", code: "X2" },
      ]);
      expect(await client.diagnostics(file, "python", "WARN\n", signal())).toEqual([
        { line: 1, character: 1, severity: 2, message: "warn here\nsecond line", code: "X1" },
      ]);
      await client.close();
      expect(client.isClosed).toBe(true);
      executor.shutdown();
    });
  }

  it("times out when the server gives nothing, and Ctrl-C stops the wait", async () => {
    const { root, client, executor } = await start("silent", {
      firstTimeoutMs: 200,
      timeoutMs: 200,
    });
    const file = join(root, "a.py");
    await expect(client.diagnostics(file, "python", "x\n", signal())).rejects.toBeInstanceOf(
      LspTimeoutError,
    );
    const controller = new AbortController();
    const wait = client.diagnostics(file, "python", "y\n", controller.signal);
    controller.abort(new Error("stopped by the user"));
    await expect(wait).rejects.toThrow("stopped by the user");
    await client.close();
    executor.shutdown();
  });
});

describe("edit results carry the diagnostics (0.4)", () => {
  it("edit_file and write_file add the text; a failing source changes nothing", async () => {
    const root = folder("tools");
    const registry = new ToolRegistry(defaultTools());
    const seen: string[] = [];
    const context = toolContext(root, {
      diagnostics: async (absolute, shown, text) => {
        seen.push(`${absolute}|${shown}|${text}`);
        return `1 error in ${shown} after this change (fake):\n  1:1 bad`;
      },
    });
    const created = await registry.execute(
      toolUse("write_file", { path: "a.py", content: "x = 1\n" }, "t1"),
      context,
    );
    expect(created.content).toBe(
      "Created a.py (1 lines).\n\n1 error in a.py after this change (fake):\n  1:1 bad",
    );
    const edited = await registry.execute(
      toolUse("edit_file", { path: "a.py", old_string: "1", new_string: "2" }, "t2"),
      context,
    );
    expect(edited.content).toMatch(/^Edited a\.py\.\n\n1 error in a\.py/);
    expect(seen).toEqual([
      `${join(root, "a.py")}|a.py|x = 1\n`,
      `${join(root, "a.py")}|a.py|x = 2\n`,
    ]);

    const broken = toolContext(root, {
      diagnostics: async () => {
        throw new Error("server gone");
      },
    });
    const again = await registry.execute(
      toolUse("write_file", { path: "b.py", content: "y\n" }, "t3"),
      broken,
    );
    expect(again).toEqual({ content: "Created b.py (1 lines).", isError: false });
  });

  it("is off by default: no prompt line, no LSP in the banner; the setting and the option turn it on", async () => {
    expect(buildSystemPrompt("/r", undefined)).not.toContain("language");
    expect(buildSystemPrompt("/r", undefined, undefined, { lsp: true })).toContain(
      "Fix the errors that your change caused.",
    );
    expect(parseSettings({ lsp: { enabled: true } }).lsp).toEqual({ enabled: true });
    expect(() => parseSettings({ lsp: { on: true } })).toThrow(/lsp/);
    const make = (settings: object, lsp?: { enabled: boolean }) =>
      Runtime.create({
        root: folder("rt"),
        modelId: "fake",
        model: new FakeModelClient([]),
        approver: new AutoApprover("deny"),
        store: new FileSessionStore(base),
        settings: parseSettings(settings),
        mcp: false,
        hooks: false,
        commands: false,
        profiles: [],
        ...(lsp === undefined ? {} : { lsp: { ...lsp, home: folder("home") } }),
      });
    const off = await make({});
    expect(off.lspEnabled).toBe(false);
    expect(off.extras()).not.toContain("LSP");
    const on = await make({ lsp: { enabled: true } });
    expect(on.extras()).toContain("LSP");
    expect(on.system).toContain("Fix the errors that your change caused.");
    expect((await make({ lsp: { enabled: true } }, { enabled: false })).lspEnabled).toBe(false);
  });
});

describe("the manager without an OS sandbox (0.4)", () => {
  it("does not start servers on the host, and says so once", async () => {
    const root = folder("host");
    const notices: string[] = [];
    const manager = new LspManager({
      root,
      executor: new HostExecutor(),
      policy: () => new PermissionEngine({ root, approver: new Recorder() }).serverPolicy(),
      home: folder("home"),
      path: fakeBin("pull"),
      notify: (t) => notices.push(t),
    });
    expect(await manager.diagnostics(join(root, "a.py"), "a.py", "ERROR", signal())).toBe(
      undefined,
    );
    expect(await manager.diagnostics(join(root, "b.py"), "b.py", "ERROR", signal())).toBe(
      undefined,
    );
    expect(notices).toEqual([
      "Python diagnostics are off for this session: pyright: it needs the OS sandbox, and this session has none",
    ]);
    expect(manager.status()[1]).toMatchObject({ language: "python", state: "failed" });
  });

  it("gives no text for other languages and missing servers", async () => {
    const root = folder("missing");
    const install: string[] = [];
    const manager = new LspManager({
      root,
      executor: new HostExecutor(),
      policy: () => new PermissionEngine({ root, approver: new Recorder() }).serverPolicy(),
      home: folder("home"),
      path: "",
      install: async (language) => {
        install.push(language);
        return false;
      },
    });
    expect(await manager.diagnostics(join(root, "A.java"), "A.java", "x", signal())).toBe(
      undefined,
    );
    expect(await manager.diagnostics(join(root, "a.ts"), "a.ts", "x", signal())).toBe(undefined);
    expect(await manager.diagnostics(join(root, "b.ts"), "b.ts", "x", signal())).toBe(undefined);
    expect(install).toEqual(["typescript"]);
    expect(manager.status()[0]).toMatchObject({ language: "typescript", state: "missing" });
  });
});

describe.runIf(osExecutor !== undefined)("language servers in the OS sandbox (0.4)", () => {
  const executor = osExecutor as NonNullable<typeof osExecutor>;
  const manager = (
    root: string,
    path: string,
    extra: Partial<ConstructorParameters<typeof LspManager>[0]> = {},
  ) =>
    new LspManager({
      root,
      executor,
      policy: () =>
        new PermissionEngine({
          root,
          approver: new Recorder(),
          isolation: executor.isolation,
        }).serverPolicy(),
      home: folder("home"),
      path,
      firstTimeoutMs: 10_000,
      timeoutMs: 5_000,
      ...extra,
    });

  it("the server policy keeps the project read-only, with no network", () => {
    const root = folder("policy");
    const policy = new PermissionEngine({ root, approver: new Recorder() }).serverPolicy();
    expect(policy).toMatchObject({
      sandbox: true,
      network: false,
      timeoutMs: 0,
      maxOutputBytes: 0,
    });
    expect(policy.denyWritePaths[0]).toBe(root);
    expect(policy.writePaths).not.toContain(root);
  });

  it("a fake server gives the errors of the changed file", async () => {
    const root = folder("fake");
    const m = manager(root, fakeBin("push"));
    const file = join(root, "a.py");
    expect(await m.diagnostics(file, "a.py", "x = ERROR\ny = WARN\n", signal())).toBe(
      "1 error in a.py after this change (pyright):\n  1:5 error here [X1]",
    );
    expect(await m.diagnostics(file, "a.py", "x = 1\n", signal())).toBe(
      "No errors in a.py (pyright).",
    );
    expect(m.status()[1]).toMatchObject({ state: "running", server: { source: "path" } });
    await m.close();
  });

  it("a crashing server turns diagnostics off with one notice; edits go on", async () => {
    const root = folder("crash");
    const notices: string[] = [];
    const m = manager(root, fakeBin("crash"), { notify: (t) => notices.push(t) });
    expect(await m.diagnostics(join(root, "a.py"), "a.py", "ERROR", signal())).toBe(undefined);
    expect(await m.diagnostics(join(root, "a.py"), "a.py", "ERROR", signal())).toBe(undefined);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^Python diagnostics are off for this session: pyright: /);
    await m.close();
  });

  it("a slow server gives no text and one notice", async () => {
    const root = folder("slow");
    const notices: string[] = [];
    const m = manager(root, fakeBin("silent"), {
      notify: (t) => notices.push(t),
      firstTimeoutMs: 300,
      timeoutMs: 300,
    });
    expect(await m.diagnostics(join(root, "a.py"), "a.py", "ERROR", signal())).toBe(undefined);
    expect(await m.diagnostics(join(root, "a.py"), "a.py", "ERROR 2", signal())).toBe(undefined);
    expect(notices).toEqual([
      "pyright: The language server gave no diagnostics within 0.3 s. Edits go on without it.",
    ]);
    expect(m.status()[1]).toMatchObject({ state: "running" });
    await m.close();
  });

  it("autoInstall: a yes installs, then the manager looks again", async () => {
    const root = folder("auto");
    const home = folder("home");
    const bin = join(managedDir("python", home), "node_modules", ".bin");
    const m = manager(root, "", {
      home,
      install: async () => {
        mkdirSync(bin, { recursive: true });
        writeFileSync(
          join(bin, "pyright-langserver"),
          readFileSync(join(fakeBin("pull"), "pyright-langserver")),
        );
        chmodSync(join(bin, "pyright-langserver"), 0o755);
        return true;
      },
    });
    expect(await m.diagnostics(join(root, "a.py"), "a.py", "ERROR", signal())).toMatch(
      /^1 error in a\.py/,
    );
    expect(m.status()[1]).toMatchObject({ server: { source: "managed" } });
    await m.close();
  });

  it("a turn: the model edits a file and reads the errors in the result", async () => {
    const root = folder("turn");
    writeFileSync(join(root, "a.py"), "x = 1\n");
    const model = new FakeModelClient([
      reply([toolUse("read_file", { path: "a.py" }, "t1")]),
      reply([toolUse("edit_file", { path: "a.py", old_string: "1", new_string: "ERROR" }, "t2")]),
      reply([text("Done.")]),
    ]);
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model,
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({ lsp: { enabled: true } }),
      mcp: false,
      hooks: false,
      commands: false,
      profiles: [],
      lsp: { home: folder("home"), path: fakeBin("pull") },
    });
    await runtime.runTurn("Break it.", signal());
    const result = model.requests[2]?.messages.at(-1)?.content[0] as ToolResultBlock;
    expect(result.content).toBe(
      "Edited a.py.\n\n1 error in a.py after this change (pyright):\n  1:5 error here [X1]",
    );
    expect(await runtime.lspStatus()).toMatch(/Python: pyright \(PATH, .*\), running/);
    await runtime.close();
    runtime.executor.shutdown();
  });

  const repoTsc = join(REPO_BIN, "tsc");
  it.runIf(isTypeScript7(repoTsc))(
    "the real tsc --lsp finds a type error, and its fix",
    async () => {
      const root = folder("tsc");
      writeFileSync(join(root, "tsconfig.json"), '{ "compilerOptions": { "strict": true } }');
      const m = manager(root, REPO_BIN);
      const file = join(root, "a.ts");
      expect(await m.diagnostics(file, "a.ts", 'export const n: number = "x";\n', signal())).toBe(
        "1 error in a.ts after this change (tsc):\n  1:14 Type 'string' is not assignable to type 'number'. [2322]",
      );
      expect(await m.diagnostics(file, "a.ts", "export const n: number = 1;\n", signal())).toBe(
        "No errors in a.ts (tsc).",
      );
      await m.close();
    },
    30_000,
  );
});

describe("/lsp and the install question (0.4)", () => {
  it("/lsp shows the state; a bad argument shows the usage", async () => {
    const runtime = await Runtime.create({
      root: folder("chat"),
      modelId: "fake",
      model: new FakeModelClient([]),
      approver: new AutoApprover("deny"),
      store: new FileSessionStore(base),
      settings: parseSettings({}),
      mcp: false,
      hooks: false,
      commands: false,
      profiles: [],
      lsp: { home: folder("home"), path: fakeBin("pull") },
    });
    const store = new ChatStore({ model: "fake", sandbox: "none" }, { paint: noColor });
    const context = { runtime, renderer: store, sessionPath: (id: string) => id };
    expect(await runCommand("/lsp", context)).toBe("done");
    expect(await runCommand("/lsp remove python", context)).toBe("done");
    const out = store.getState().items.map((i) => i.text);
    expect(out[0]).toMatch(/^LSP diagnostics are off\. Turn them on with --lsp/);
    expect(out[0]).toContain(
      'TypeScript/JavaScript: not found. Run "garuda lsp install typescript".',
    );
    expect(out[0]).toMatch(/Python: pyright \(PATH, .*pyright-langserver\), found/);
    expect(out[1]).toBe("Use: /lsp, or /lsp install typescript, or /lsp install python.");
  });

  it("a request can show fewer choices and its own question", async () => {
    const store = new ChatStore({ model: "fake", sandbox: "none" }, { paint: noColor });
    const answer = store.ask(
      {
        tool: "lsp",
        target: { kind: "input", json: "{}" },
        preview: "x",
        isolation: "os",
        question: "Install it?",
        choices: ["once", "deny"],
        labels: { once: "Yes, install it" },
      },
      signal(),
    );
    const approval = store.getState().approval;
    expect(approval?.choices.map((c) => c.label)).toEqual(["Yes, install it", "No, deny"]);
    store.moveApproval(1);
    store.moveApproval(1);
    expect(store.getState().approval?.selected).toBe(0);
    store.choose("session");
    expect(store.getState().approval).toBeDefined();
    store.choose("deny");
    expect(await answer).toBe("deny");
    expect(approvalKeys(["once", "deny"])).toBe("↑↓ and Enter, or 1 2 · y = 1 · n or Esc = 2");
    expect(approvalKeys(["once", "session", "deny"])).toBe(
      "↑↓ and Enter, or 1 2 3 · y = 1 · a = 2 · n or Esc = 3",
    );
  });
});
