import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { agentSystem, agentTools, agentWrites } from "../src/agents/agentTool.js";
import { type CustomAgent, loadAgents, parseAgent, toolMatches } from "../src/agents/custom.js";
import { Runtime } from "../src/app/runtime.js";
import { agentsText } from "../src/cli/chat/commands.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { aliasModel, type ModelInfo } from "../src/model/pricing.js";
import type { ToolResultBlock } from "../src/model/types.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../src/permissions/types.js";
import { FileSessionStore } from "../src/session/store.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-agents-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function setup(user: Record<string, string> = {}, project: Record<string, string> = {}) {
  const dir = join(base, `a${n++}`);
  const home = join(dir, "home");
  const root = join(dir, "root");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  write(home, user);
  write(root, { "src/math.js": "export const add = (a, b) => a - b;\n", ...project });
  return { home, root };
}

function write(top: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const file = join(top, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

const agentMd = (name: string, description: string, extra = "", body = `You are ${name}.`) =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`;

class Recorder implements Approver {
  readonly requests: ApprovalRequest[] = [];
  constructor(private readonly answers: ApprovalChoice[] = []) {}
  async ask(request: ApprovalRequest): Promise<ApprovalChoice> {
    this.requests.push(request);
    return this.answers.shift() ?? "deny";
  }
}

const place = { file: "/x/r.md", shown: "~/.claude/agents/r.md", source: "user" as const };
const signal = () => new AbortController().signal;
const INFO: ModelInfo = {
  contextWindow: 200_000,
  price: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};

describe("agents: the file format (0.5)", () => {
  it("reads Claude Code's format: tools as a list or a string, maxTurns, disallowedTools", () => {
    const notes: string[] = [];
    const agent = parseAgent(
      agentMd(
        "code-reviewer",
        "Reviews code. Use proactively after changes.",
        "tools:\n  - Read\n  - Grep\n  - Bash(git diff *)\n  - NotebookEdit\n  - mcp__github\nmodel: sonnet\nmaxTurns: 7\ndisallowedTools: Write\ncolor: blue\npermissionMode: acceptEdits\n",
      ),
      place,
      notes,
    ) as CustomAgent;
    expect(agent).toMatchObject({
      name: "code-reviewer",
      description: "Reviews code. Use proactively after changes.",
      tools: ["read_file", "grep", "bash", "mcp__github"],
      disallowed: ["write_file"],
      model: "sonnet",
      maxSteps: 7,
      prompt: "You are code-reviewer.",
    });
    expect(notes.join("\n")).toContain('"Bash(git diff *)": the part in brackets is left out');
    expect(notes.join("\n")).toContain('the tool "NotebookEdit" is left out');
    expect(notes.join("\n")).toContain('"permissionmode" is left out');
    const plain = parseAgent(
      agentMd("x", "X.", "tools: Read, Edit, Write\n"),
      place,
    ) as CustomAgent;
    expect(plain.tools).toEqual(["read_file", "edit_file", "write_file"]);
    expect((parseAgent(agentMd("y", "Y."), place) as CustomAgent).tools).toBeUndefined();
  });

  it("refuses bad files, and a project may not pick the model", () => {
    expect(parseAgent("---\ndescription: d\n---\nx", place)).toMatch(/no name/);
    expect(parseAgent(agentMd("a:b", "d"), place)).toMatch(/not valid/);
    expect(parseAgent("---\nname: z\n---\nbody", place)).toMatch(/no description/);
    const notes: string[] = [];
    const project = parseAgent(
      agentMd("p", "P.", "model: opus\n"),
      { ...place, source: "project" },
      notes,
    );
    expect((project as CustomAgent).model).toBeUndefined();
    expect(notes.join("\n")).toContain("only you pick models");
  });

  it("maps model aliases like Claude Code", () => {
    expect(aliasModel("haiku")).toBe("claude-haiku-4-5");
    expect(aliasModel("sonnet")).toMatch(/^claude-sonnet-/);
    expect(aliasModel("gpt")).toBeUndefined();
  });

  it("loads the four folders; a user agent wins over a project agent", async () => {
    const { home, root } = setup(
      {
        ".claude/agents/reviewer.md": agentMd("reviewer", "User reviewer."),
        ".garuda/agents/tester.md": agentMd("tester", "Tests."),
      },
      {
        ".garuda/agents/reviewer.md": agentMd("reviewer", "Project reviewer."),
        ".claude/agents/docs.md": agentMd("docs", "Docs."),
        ".claude/agents/notes.txt": "not an agent",
        "elsewhere.md": agentMd("linked", "L."),
      },
    );
    symlinkSync(join(root, "elsewhere.md"), join(root, ".claude", "agents", "linked.md"));
    const { agents, problems } = await loadAgents({ home, root });
    expect(agents.map((a) => `${a.name}:${a.source}:${a.description}`)).toEqual([
      "docs:project:Docs.",
      "reviewer:user:User reviewer.",
      "tester:user:Tests.",
    ]);
    expect(problems.join("\n")).toContain(
      'an agent named "reviewer" is already in ~/.claude/agents/reviewer.md',
    );
    expect(problems.join("\n")).toContain("may not be a symbolic link");
  });

  it("gives read-only tools by default, never nests, and matches MCP patterns", () => {
    const registry = new ToolRegistry(defaultTools({ codeIndex: "off" }));
    const agent = (tools?: string[], disallowed: string[] = []) =>
      ({ name: "a", tools, disallowed }) as unknown as CustomAgent;
    expect(agentTools(agent(), registry)).toEqual(["glob", "grep", "read_file"]);
    expect(agentTools(agent(["read_file", "bash", "edit_file"], ["bash"]), registry)).toEqual([
      "edit_file",
      "read_file",
    ]);
    expect(agentWrites(agent(["read_file", "edit_file"]))).toBe(true);
    expect(agentWrites(agent(["read_file", "grep"]))).toBe(false);
    expect(agentWrites(agent())).toBe(false);
    expect(toolMatches("mcp__github__get_issue", "mcp__github")).toBe(true);
    expect(toolMatches("mcp__github__get_issue", "mcp__*")).toBe(true);
    expect(toolMatches("mcp__gitlab__x", "mcp__github")).toBe(false);
    expect(
      agentSystem({ ...agent(), prompt: "Be kind.", shown: "s" } as CustomAgent, "/r"),
    ).toContain("# Agent instructions (s)\n\nBe kind.");
  });
});

describe("agents in the runtime (0.5)", () => {
  async function runtimeFor(
    home: string,
    root: string,
    model: FakeModelClient,
    approver: Approver = new Recorder(),
    extra: { settings?: Record<string, unknown>; resolve?: (spec: string) => void } = {},
  ) {
    return Runtime.create({
      root,
      modelId: "fake-main",
      model: async () => model,
      modelInfo: INFO,
      approver,
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host", ...extra.settings }),
      mcp: false,
      hooks: false,
      profiles: [],
      agents: {
        home,
        resolveModel: (spec) => {
          extra.resolve?.(spec);
          return { spec, model: async () => model, info: INFO };
        },
      },
    });
  }

  const resultOf = (model: FakeModelClient, step: number) =>
    model.requests[step]?.messages
      .at(-1)
      ?.content.find((b): b is ToolResultBlock => b.type === "tool_result");

  it("hands a task to a read-only agent: own prompt and tools, a report back, usage counted", async () => {
    const { home, root } = setup({
      ".claude/agents/math-checker.md": agentMd(
        "math-checker",
        "Checks math functions.",
        "",
        "Compare each function's operator with its name.",
      ),
    });
    const model = new FakeModelClient([
      reply([
        toolUse("agent", { agent: "math-checker", prompt: "Check src/math.js for bugs." }, "a1"),
      ]),
      // The child: its own system prompt and only read-only tools.
      (request) => {
        expect(request.system).toContain('You are "math-checker", a subagent of Garuda');
        expect(request.system).toContain("Compare each function's operator with its name.");
        expect(request.tools.map((t) => t.name)).toEqual(["glob", "grep", "read_file"]);
        return reply([toolUse("read_file", { path: "src/math.js" }, "c1")]);
      },
      reply([text("add uses - instead of +. src/math.js:1")]),
      (request) => {
        expect(request.system).toContain("Custom agents do kinds of tasks");
        return reply([text("Found it.")]);
      },
    ]);
    const runtime = await runtimeFor(home, root, model);
    expect(runtime.toolNames()).toContain("agent");
    expect(runtime.extras()).toContain("1 agent");
    const result = await runtime.runTurn("Any math bugs?", signal());
    expect(result.stopReason).toBe("done");
    expect(model.remaining).toBe(0);
    const report = resultOf(model, 3);
    expect(report?.content).toContain("add uses - instead of +. src/math.js:1");
    expect(report?.content).toMatch(/\[agent math-checker: 2 steps · .*k tokens\]/);
    expect(report?.content).toContain("[calls: read_file src/math.js]");
    // The child's usage counts for the session and the run.
    expect(result.usage.outputTokens).toBeGreaterThan(model.requests.length);
    const id = runtime.session?.id as string;
    expect(existsSync(new FileSessionStore(root).childPath(id, "agent-math-checker-a1"))).toBe(
      true,
    );
    expect(agentsText(runtime)).toMatch(/math-checker\s+Checks math functions\./);
    expect(agentsText(runtime)).toContain("read-only tools · ~/.claude/agents/math-checker.md");
  });

  it("an agent file's maxTurns cannot raise the step limit of the settings (0.14, review)", async () => {
    const { home, root } = setup({
      ".claude/agents/long.md": agentMd("long", "Runs long.", "maxTurns: 50\n"),
    });
    const model = new FakeModelClient([
      reply([toolUse("agent", { agent: "long", prompt: "Look around." }, "a1")]),
      reply([toolUse("read_file", { path: "src/math.js" }, "c1")]),
      reply([text("Done looking.")]),
      reply([text("OK.")]),
    ]);
    const runtime = await runtimeFor(home, root, model, new Recorder(), {
      settings: { subagents: { maxSteps: 1 } },
    });
    await runtime.runTurn("Go", signal());
    expect(resultOf(model, 3)?.content).toContain("stopped early (max_steps)");
  });

  it("an agent with write tools edits through the permission engine and runs alone", async () => {
    const { home, root } = setup({
      ".garuda/agents/fixer.md": agentMd("fixer", "Fixes bugs.", "tools: Read, Edit\n"),
    });
    const model = new FakeModelClient([
      reply([toolUse("agent", { agent: "fixer", prompt: "Fix add in src/math.js." }, "a1")]),
      reply([toolUse("read_file", { path: "src/math.js" }, "c1")]),
      reply([
        toolUse(
          "edit_file",
          { path: "src/math.js", old_string: "a - b", new_string: "a + b" },
          "c2",
        ),
      ]),
      reply([text("Fixed src/math.js:1.")]),
      reply([text("Done.")]),
    ]);
    const approver = new Recorder(["once"]);
    const runtime = await runtimeFor(home, root, model, approver);
    await runtime.runTurn("Fix the bug", signal());
    expect(readFileSync(join(root, "src", "math.js"), "utf8")).toContain("a + b");
    expect(approver.requests.map((r) => r.tool)).toEqual(["edit_file"]);
    expect(runtime.toolNames()).toContain("agent");
    // runsAlone: the loop does not batch it with other read-only calls.
    const registry = (runtime as unknown as { tools: ToolRegistry }).tools;
    expect(registry.isReadOnly("agent")).toBe(false);
  });

  it("plan mode also holds for the agent's calls", async () => {
    const { home, root } = setup({
      ".garuda/agents/fixer.md": agentMd("fixer", "Fixes bugs.", "tools: Read, Edit\n"),
    });
    const model = new FakeModelClient([
      reply([toolUse("agent", { agent: "fixer", prompt: "Fix add in src/math.js." }, "a1")]),
      reply([toolUse("read_file", { path: "src/math.js" }, "c0")]),
      reply([
        toolUse(
          "edit_file",
          { path: "src/math.js", old_string: "a - b", new_string: "a + b" },
          "c1",
        ),
      ]),
      reply([text("I could not edit.")]),
      reply([text("Plan: fix add.")]),
    ]);
    const runtime = await runtimeFor(home, root, model, new Recorder(["once"]));
    runtime.setMode("plan");
    await runtime.runTurn("Fix the bug", signal());
    expect(readFileSync(join(root, "src", "math.js"), "utf8")).toContain("a - b");
    expect(JSON.stringify(model.requests[3]?.messages.at(-1))).toMatch(/plan mode/i);
  });

  it("a project agent asks once with its tools and instructions; No gives an error result", async () => {
    const { home, root } = setup(
      {},
      {
        ".claude/agents/docs.md": agentMd(
          "docs",
          "Writes docs.",
          "tools: Read, Write\n",
          "Write docs.",
        ),
      },
    );
    const model = new FakeModelClient([
      reply([toolUse("agent", { agent: "docs", prompt: "Document src/math.js." }, "a1")]),
      reply([text("OK, without it.")]),
    ]);
    const approver = new Recorder(["deny"]);
    const runtime = await runtimeFor(home, root, model, approver);
    await runtime.runTurn("Docs please", signal());
    expect(approver.requests[0]?.title).toBe('Use the project agent "docs"?');
    expect(approver.requests[0]?.preview).toContain("Its tools: read_file, write_file.");
    expect(approver.requests[0]?.preview).toContain("  │ Write docs.");
    const result = resultOf(model, 1);
    expect(result?.isError).toBe(true);
    expect(result?.content).toMatch(/did not allow the project agent "docs"/);
  });

  it("a user agent's model: an alias or an id goes through the CLI's providers", async () => {
    const { home, root } = setup({
      ".garuda/agents/quick.md": agentMd("quick", "Quick checks.", "model: haiku\n"),
    });
    const specs: string[] = [];
    const model = new FakeModelClient([
      reply([toolUse("agent", { agent: "quick", prompt: "Say hi to the user." }, "a1")]),
      reply([text("hi")]),
      reply([text("done")]),
    ]);
    const runtime = await runtimeFor(home, root, model, new Recorder(), {
      resolve: (spec) => specs.push(spec),
    });
    await runtime.runTurn("Hi", signal());
    expect(specs).toEqual(["claude-haiku-4-5"]);
  });

  it("no agent tool without agent files or with agents.enabled false", async () => {
    const empty = setup();
    const model = new FakeModelClient([]);
    expect((await runtimeFor(empty.home, empty.root, model)).toolNames()).not.toContain("agent");
    const { home, root } = setup({ ".garuda/agents/a.md": agentMd("a", "A.") });
    const off = await runtimeFor(home, root, model, new Recorder(), {
      settings: { agents: { enabled: false } },
    });
    expect(off.toolNames()).not.toContain("agent");
    expect(off.agents).toEqual([]);
  });
});
