import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { HELP, runCommand } from "../src/cli/chat/commands.js";
import { PlainRenderer } from "../src/cli/renderer.js";
import { runRepl } from "../src/cli/repl.js";
import { BUILTIN_COMMANDS } from "../src/commands/builtins.js";
import { loadCommands } from "../src/commands/custom.js";
import {
  claudeRule,
  commandFromMarkdown,
  commandFromToml,
  commandPart,
  convertEnv,
  openCodeRules,
  parseJsonc,
  serverName,
} from "../src/init/convert.js";
import { folderKind, initTip } from "../src/init/detect.js";
import { applyPlan, buildPlan, GITIGNORE_LINES, previewText } from "../src/init/plan.js";
import { initPrompt, runInit } from "../src/init/run.js";
import { loadToml, readAllSources } from "../src/init/sources.js";
import type { ImportItem } from "../src/init/types.js";
import { loadMcpConfig } from "../src/mcp/config.js";
import { FakeModelClient, reply, text } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { ApprovalRequest } from "../src/permissions/types.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { FileSessionStore } from "../src/session/store.js";
import { sink } from "./helpers.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-init-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
beforeAll(loadToml);

let n = 0;
function setup(project: Record<string, string> = {}, user: Record<string, string> = {}) {
  const dir = join(base, `i${n++}`);
  const root = join(dir, "root");
  const home = join(dir, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  write(root, project);
  write(home, user);
  return { root, home };
}

function write(top: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const file = join(top, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

const read = (path: string) => readFileSync(path, "utf8");
const json = (value: unknown) => JSON.stringify(value, null, 2);
const signal = () => new AbortController().signal;
const byKind = <K extends ImportItem["kind"]>(items: ImportItem[], kind: K) =>
  items.filter((i): i is Extract<ImportItem, { kind: K }> => i.kind === kind);

describe("init: conversions (0.5)", () => {
  it("makes valid server and command names, or none", () => {
    expect(serverName("My-Server.v2")).toBe("my_server_v2");
    expect(serverName("---")).toBeUndefined();
    expect(commandPart("Fix Issue")).toBe("fix-issue");
    expect(commandPart("!!")).toBeUndefined();
  });

  it("never copies a secret value into an env entry", () => {
    const notes: string[] = [];
    const env = convertEnv(
      { GITHUB_TOKEN: "ghp_real", REGION: "eu", HOME_DIR: "{env:HOME}", KEY2: "${KEY2}" },
      ".mcp.json",
      notes,
    );
    expect(env).toEqual({
      GITHUB_TOKEN: "${GITHUB_TOKEN}",
      REGION: "eu",
      HOME_DIR: "${HOME}",
      KEY2: "${KEY2}",
    });
    expect(JSON.stringify(env)).not.toContain("ghp_real");
    expect(notes.join("\n")).toContain("GITHUB_TOKEN");
  });

  it("keeps description and argument-hint of a Markdown command, with notes for the rest", () => {
    const notes: string[] = [];
    const out = commandFromMarkdown(
      "---\ndescription: Review\nallowed-tools: Bash\nargument-hint: <file>\n---\nReview $ARGUMENTS\n!`git diff`\n",
      notes,
    );
    expect(out).toBe(
      "---\ndescription: Review\nargument-hint: <file>\n---\nReview $ARGUMENTS\n!`git diff`\n",
    );
    expect(notes.join("\n")).toContain('"allowed-tools"');
    expect(notes.join("\n")).toContain("shell commands");
  });

  it("turns a TOML command into Markdown, with {{args}} as $ARGUMENTS", () => {
    const notes: string[] = [];
    expect(commandFromToml({ description: "Fix", prompt: "Fix {{args}} now" }, notes)).toBe(
      "---\ndescription: Fix\n---\nFix $ARGUMENTS now\n",
    );
    expect(commandFromToml({ description: "no prompt" }, notes)).toBeUndefined();
  });

  it("converts Claude Code permission rules", () => {
    expect(claudeRule("Bash(npm run test:*)")).toEqual(["bash(npm run test*)"]);
    expect(claudeRule("Bash(git diff *)")).toEqual(["bash(git diff*)"]);
    expect(claudeRule("Read(./.env)")).toEqual(["read_file(.env)"]);
    expect(claudeRule("Edit(src/**)")).toEqual(["edit_file(src/**)", "write_file(src/**)"]);
    expect(claudeRule("WebFetch(domain:docs.python.org)")).toEqual(["web_fetch(docs.python.org)"]);
    expect(claudeRule("mcp__github__get_issue")).toEqual(["mcp__github__get_issue"]);
    expect(claudeRule("NotebookEdit")).toBeUndefined();
  });

  it("converts OpenCode permissions; ask adds nothing", () => {
    expect(
      openCodeRules({ bash: { "git *": "allow", "rm *": "deny", "*": "ask" }, edit: "deny" }),
    ).toEqual([
      { list: "allow", rule: "bash(git*)" },
      { list: "deny", rule: "bash(rm*)" },
      { list: "deny", rule: "edit_file" },
      { list: "deny", rule: "write_file" },
    ]);
  });

  it("reads JSON with comments and trailing commas, and keeps // in strings", () => {
    expect(parseJsonc('{\n // c\n "u": "https://x", /* b */ "a": [1,],\n}')).toEqual({
      u: "https://x",
      a: [1],
    });
  });
});

/** One folder with files of every agent. */
function everyAgent() {
  return setup(
    {
      ".mcp.json": json({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "ghp_secret" },
          },
          old: { type: "sse", url: "https://old.example.com/sse" },
        },
      }),
      ".claude/commands/review.md": "---\ndescription: Review\n---\nReview $ARGUMENTS\n",
      ".claude/commands/help.md": "A command with a built-in name\n",
      ".claude/settings.json": json({
        permissions: { allow: ["Bash(pnpm test:*)", "NotebookEdit"], deny: ["Read(./.env)"] },
        hooks: {},
      }),
      "opencode.jsonc": `{
        // OpenCode
        "mcp": {
          "linear": { "type": "remote", "url": "https://mcp.linear.app/mcp", "headers": { "X": "1" } },
          "files": { "type": "local", "command": ["node", "files.js"], "enabled": false },
        },
        "command": { "deploy": { "template": "Deploy $ARGUMENTS", "description": "Deploy" } },
        "permission": { "bash": { "git *": "allow" } },
      }`,
      ".codex/config.toml": '[mcp_servers.docs]\ncommand = "docs-mcp"\nenv_vars = ["DOCS_KEY"]\n',
      ".gemini/settings.json": json({
        mcpServers: {
          remote: { httpUrl: "https://gem.example.com/mcp" },
          legacy: { url: "https://gem.example.com/sse" },
        },
      }),
      ".gemini/commands/git/commit.toml": 'description = "Commit"\nprompt = "Commit {{args}}"\n',
      "GEMINI.md": "Use tabs.\n",
      ".tabnine/agent/commands/tn.toml": 'prompt = "Tabnine {{args}}"\n',
      ".tabnine/guidelines/style.md": "Style.\n",
      "TABNINE.md": "Tabnine rules.\n",
      ".cursor/mcp.json": json({ mcpServers: { "!!!": { command: "x" } } }),
      ".cursorrules": "Cursor rules.\n",
      ".cursor/rules/a.mdc": "Rule a.\n",
      ".github/copilot-instructions.md": "Copilot rules.\n",
    },
    {
      ".claude.json": json({
        mcpServers: { memory: { command: "mem", args: ["--api-key", "x"] } },
      }),
      ".codex/prompts/explain.md": "Explain $1\n",
      ".config/opencode/opencode.json": json({ permission: { edit: "allow" } }),
    },
  );
}

describe("init: reading other agents' files (0.5)", () => {
  it("finds MCP servers, commands, rules and instruction files of every agent", () => {
    const { root, home } = everyAgent();
    const items = readAllSources({ root, home });

    const mcp = byKind(items, "mcp").map((i) => `${i.agent}/${i.scope}/${i.name}`);
    expect(mcp).toEqual([
      "Claude Code/project/github",
      "Claude Code/user/memory",
      "OpenCode/project/linear",
      "OpenCode/project/files",
      "Codex/project/docs",
      "Gemini CLI/project/remote",
    ]);
    const github = byKind(items, "mcp").find((i) => i.name === "github");
    expect(github?.def).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
    });
    expect(JSON.stringify(items)).not.toContain("ghp_secret");
    const memory = byKind(items, "mcp").find((i) => i.name === "memory");
    expect(memory?.notes.join("\n")).toContain("may hold a secret");
    const linear = byKind(items, "mcp").find((i) => i.name === "linear");
    expect(linear?.def).toEqual({ url: "https://mcp.linear.app/mcp" });
    expect(linear?.notes.join("\n")).toContain("HTTP headers");
    expect(byKind(items, "mcp").find((i) => i.name === "files")?.def).toMatchObject({
      command: "node",
      args: ["files.js"],
      enabled: false,
    });
    expect(byKind(items, "mcp").find((i) => i.name === "docs")?.def).toMatchObject({
      env: { DOCS_KEY: "${DOCS_KEY}" },
    });

    const commands = byKind(items, "command").map((i) => `${i.agent}/${i.scope}/${i.name}`);
    expect(commands).toEqual([
      "Claude Code/project/help",
      "Claude Code/project/review",
      "OpenCode/project/deploy",
      "Codex/user/explain",
      "Gemini CLI/project/git:commit",
      "Tabnine/project/tn",
    ]);
    expect(byKind(items, "command").find((i) => i.name === "git:commit")?.text).toBe(
      "---\ndescription: Commit\n---\nCommit $ARGUMENTS\n",
    );

    const rules = byKind(items, "rule").map((i) => `${i.list} ${i.rule}`);
    expect(rules).toEqual(["allow bash(pnpm test*)", "deny read_file(.env)", "allow bash(git*)"]);

    expect(byKind(items, "instructions").map((i) => i.path)).toEqual([
      "GEMINI.md",
      "TABNINE.md",
      ".tabnine/guidelines/style.md",
      ".cursorrules",
      ".cursor/rules/a.mdc",
      ".github/copilot-instructions.md",
    ]);

    const skipped = byKind(items, "skipped").map((i) => `${i.agent}: ${i.what}: ${i.notes[0]}`);
    expect(skipped).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Claude Code: the MCP server "old": it uses SSE'),
        expect.stringContaining("Claude Code: the rule NotebookEdit"),
        expect.stringContaining("Claude Code: hooks"),
        expect.stringContaining("OpenCode: your personal permission rules"),
        expect.stringContaining('Gemini CLI: the MCP server "legacy": it uses SSE'),
        expect.stringContaining('Cursor: the MCP server "!!!"'),
      ]),
    );
  });

  it("reports a file that does not parse, and reads the rest", () => {
    const { root, home } = setup({
      ".mcp.json": "{ not json",
      ".codex/config.toml": "[[[",
      ".cursor/mcp.json": json({ mcpServers: { ok: { command: "ok" } } }),
    });
    const items = readAllSources({ root, home });
    expect(byKind(items, "skipped").map((i) => i.what)).toEqual(["a settings file", "a TOML file"]);
    expect(byKind(items, "mcp").map((i) => i.name)).toEqual(["ok"]);
  });

  it("skips a project server on a private address", () => {
    const { root, home } = setup({
      ".mcp.json": json({ mcpServers: { local: { type: "http", url: "http://127.0.0.1:9/mcp" } } }),
    });
    const items = readAllSources({ root, home });
    expect(byKind(items, "mcp")).toEqual([]);
    expect(byKind(items, "skipped")[0]?.notes[0]).toContain("https");
  });

  it("finds nothing in an empty folder", () => {
    const { root, home } = setup();
    expect(readAllSources({ root, home })).toEqual([]);
  });
});

describe("init: the plan (0.5)", () => {
  it("writes new files that Garuda can load, and shows them in the preview", async () => {
    const { root, home } = everyAgent();
    const plan = buildPlan(readAllSources({ root, home }), { root, home, defaults: true });
    expect(plan.writes.map((w) => `${w.mode} ${w.shown}`)).toEqual([
      "new ~/.garuda/mcp.json",
      "new .garuda/mcp.json",
      "new .garuda/commands/review.md",
      "new .garuda/commands/deploy.md",
      "new ~/.garuda/commands/explain.md",
      "new .garuda/commands/git/commit.md",
      "new .garuda/commands/tn.md",
      "new .garuda/settings.json",
      "new .gitignore",
    ]);

    const preview = previewText(plan);
    expect(preview).toContain("From Claude Code:");
    expect(preview).toContain("  + MCP server github (.mcp.json) → .garuda/mcp.json");
    expect(preview).toContain(
      "      ! GITHUB_TOKEN held a value in .mcp.json; Garuda does not copy it",
    );
    expect(preview).toContain("  - command /help (.claude/commands/help.md): /help is a built-in");
    expect(preview).toContain("  + instructions GEMINI.md → read by the init turn");
    expect(preview).toContain("  new    .garuda/settings.json");

    expect(await applyPlan(plan)).toHaveLength(9);
    const mcp = await loadMcpConfig({ root, home });
    expect(mcp.problems).toEqual([]);
    expect(mcp.servers.map((s) => `${s.source}/${s.name}`).sort()).toEqual([
      "project/docs",
      "project/files",
      "project/github",
      "project/linear",
      "project/remote",
      "user/memory",
    ]);
    const commands = await loadCommands({ root, home, builtins: BUILTIN_COMMANDS });
    expect(commands.problems).toEqual([]);
    expect(commands.commands.map((c) => c.name)).toEqual([
      "deploy",
      "explain",
      "git:commit",
      "review",
      "tn",
    ]);
    const settings = parseSettings(JSON.parse(read(join(root, ".garuda", "settings.json"))));
    expect(settings.allow).toEqual([
      { tool: "bash", pattern: "pnpm test*" },
      { tool: "bash", pattern: "git*" },
    ]);
    expect(settings.deny).toEqual([{ tool: "read_file", pattern: ".env" }]);
    expect(settings.undo).toEqual({ enabled: true });
    expect(read(join(root, ".gitignore"))).toBe(
      `# Garuda's local state\n${GITIGNORE_LINES.join("\n")}\n`,
    );
  });

  it("never changes an existing file; it only adds missing .gitignore lines", async () => {
    const { root, home } = setup(
      {
        ".mcp.json": json({ mcpServers: { a: { command: "a" } } }),
        ".claude/commands/review.md": "new review\n",
        ".claude/settings.json": json({ permissions: { allow: ["Bash(ls)"] } }),
        ".garuda/mcp.json": '{"servers":{}}\n',
        ".garuda/commands/review.md": "mine\n",
        ".garuda/settings.json": "{}\n",
        ".gitignore": "node_modules\n.garuda/sessions/",
      },
      {},
    );
    const plan = buildPlan(readAllSources({ root, home }), { root, home, defaults: true });
    expect(plan.writes.map((w) => `${w.mode} ${w.shown}`)).toEqual(["append .gitignore"]);
    const preview = previewText(plan);
    expect(preview).toContain(".garuda/mcp.json exists; add it there by hand");
    expect(preview).toContain(".garuda/commands/review.md exists");
    expect(preview).toContain(".garuda/settings.json exists; add it there by hand");
    await applyPlan(plan);
    expect(read(join(root, ".garuda", "commands", "review.md"))).toBe("mine\n");
    expect(read(join(root, ".garuda", "settings.json"))).toBe("{}\n");
    expect(read(join(root, ".gitignore"))).toBe(
      "node_modules\n.garuda/sessions/\n# Garuda's local state\n.garuda/index/\n.garuda/evals/\n",
    );
    // Run again: nothing more to add.
    expect(buildPlan([], { root, home, defaults: true }).writes).toEqual([]);
  });

  it("keeps the first of two servers with the same name", () => {
    const { root, home } = setup({
      ".mcp.json": json({ mcpServers: { a: { command: "one" } } }),
      ".cursor/mcp.json": json({ mcpServers: { a: { command: "two" } } }),
    });
    const plan = buildPlan(readAllSources({ root, home }), { root, home, defaults: false });
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]?.content).toContain('"one"');
    expect(previewText(plan)).toContain('a server named "a" is already in the list');
  });

  it("does not replace a file that appeared after the plan", async () => {
    const { root, home } = setup({ ".mcp.json": json({ mcpServers: { a: { command: "a" } } }) });
    const plan = buildPlan(readAllSources({ root, home }), { root, home, defaults: false });
    write(root, { ".garuda/mcp.json": "theirs\n" });
    expect(await applyPlan(plan)).toEqual([]);
    expect(read(join(root, ".garuda", "mcp.json"))).toBe("theirs\n");
  });
});

describe("init: the folder (0.5)", () => {
  it("tells code, notes and empty folders apart", () => {
    expect(folderKind(setup().root)).toBe("empty");
    expect(folderKind(setup({ "notes/idea.md": "x" }).root)).toBe("notes");
    expect(folderKind(setup({ "package.json": "{}" }).root)).toBe("code");
    expect(folderKind(setup({ "a/b/main.py": "" }).root)).toBe("code");
    expect(folderKind(setup({ "node_modules/x/index.js": "", ".hidden/a.ts": "" }).root)).toBe(
      "empty",
    );
  });

  it("gives a start tip only when /init can help", () => {
    expect(initTip(setup({ "src/a.ts": "" }).root)).toContain("write AGENTS.md");
    expect(initTip(setup().root)).toContain("no code yet");
    expect(initTip(setup({ "AGENTS.md": "x" }).root)).toBeUndefined();
    expect(initTip(setup({ "AGENTS.md": "x", ".cursorrules": "x" }).root)).toBe(
      "Found files of Cursor. Type /init to bring their commands, MCP servers and rules over.",
    );
    expect(
      initTip(setup({ "AGENTS.md": "x", ".cursorrules": "x", ".garuda/settings.json": "{}" }).root),
    ).toBeUndefined();
  });

  it("writes a prompt per kind of folder", () => {
    const code = initPrompt("code", ["GEMINI.md"]);
    expect(code).toContain("Do not change any code");
    expect(code).toContain("## Build and test");
    expect(code).toContain("GEMINI.md");
    const empty = initPrompt("empty", []);
    expect(empty).toContain("This folder is empty.");
    expect(empty).toContain("Do not create files in this turn");
    expect(initPrompt("notes", [])).toContain("no code yet");
  });
});

describe("init: the command (0.5)", () => {
  it("asks once, writes the files, then offers git init", async () => {
    const { root, home } = setup({ ".cursorrules": "x", ".mcp.json": json({ mcpServers: {} }) });
    const approver = new AutoApprover("once");
    const result = await runInit({
      root,
      home,
      approver,
      executor: new HostExecutor(),
      signal: signal(),
    });
    expect(approver.requests.map((r) => r.title)).toEqual([
      "Set up Garuda here, with what Cursor left?",
      "Run git init?",
    ]);
    expect(result.kind).toBe("empty");
    expect(result.report).toEqual([
      "Wrote 2 file(s): .garuda/settings.json, .gitignore.",
      "Ran git init.",
    ]);
    expect(existsSync(join(root, ".git"))).toBe(true);
    expect(result.prompt).toContain(".cursorrules");
  });

  it("writes nothing and runs nothing on no", async () => {
    const { root, home } = setup({ "src/a.ts": "" });
    const approver = new AutoApprover("deny");
    const result = await runInit({
      root,
      home,
      approver,
      executor: new HostExecutor(),
      signal: signal(),
    });
    expect(result.report).toEqual(["Nothing written."]);
    expect(existsSync(join(root, ".garuda"))).toBe(false);
    expect(existsSync(join(root, ".git"))).toBe(false);
    expect(result.kind).toBe("code");
  });

  it("does not ask when there is nothing to write and git is there", async () => {
    const { root, home } = setup({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".garuda/settings.json": "{}\n",
      ".gitignore": `${GITIGNORE_LINES.join("\n")}\n`,
    });
    const approver = new AutoApprover("once");
    const result = await runInit({
      root,
      home,
      approver,
      executor: new HostExecutor(),
      signal: signal(),
    });
    expect(approver.requests).toEqual([]);
    expect(result.report).toEqual([]);
  });

  async function runtimeFor(root: string, home: string, model: FakeModelClient, answer = "once") {
    const approver = new AutoApprover((r: ApprovalRequest) =>
      r.tool === "init" ? (answer as "once") : "once",
    );
    const err = sink();
    const renderer = new PlainRenderer({ out: sink().stream, err: err.stream }, false);
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: async () => model,
      approver,
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      commands: { home },
      profiles: [],
      onEvent: (event) => renderer.event(event),
    });
    return { runtime, renderer, err, approver };
  }

  it("/init reports and gives the prompt of the init turn", async () => {
    const { root, home } = setup({ "src/a.ts": "" });
    const { runtime, renderer, err } = await runtimeFor(root, home, new FakeModelClient([]));
    const result = await runCommand("/init", { runtime, renderer, sessionPath: (id) => id });
    expect(result).toMatchObject({ prompt: expect.stringContaining("AGENTS.md") });
    expect(err.text()).toContain("Wrote 2 file(s)");
    expect(HELP).toContain("/init");
    expect(BUILTIN_COMMANDS).toContain("init");
  });

  it("garuda init runs /init first in the plain chat, then the init turn", async () => {
    const { root, home } = setup();
    const model = new FakeModelClient([
      (request) => {
        expect(JSON.stringify(request.messages)).toContain("This folder is empty.");
        return reply([text("What do you want to build?")]);
      },
    ]);
    const { runtime, renderer } = await runtimeFor(root, home, model, "deny");
    const input = new PassThrough();
    input.end("");
    await runRepl(
      runtime,
      { onInterrupt: () => {}, ask: async () => "deny" as const },
      renderer,
      (id) => id,
      () => {
        throw new Error("exit");
      },
      { input, output: sink().stream },
      "/init",
    );
    expect(model.remaining).toBe(0);
  });
});
