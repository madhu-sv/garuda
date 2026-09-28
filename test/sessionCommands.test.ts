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
import { afterAll, describe, expect, it } from "vitest";
import { modelFacts, Runtime, type RuntimeOptions } from "../src/app/runtime.js";
import { runCommand } from "../src/cli/chat/commands.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { sessionMarkdown, writeExport } from "../src/cli/export.js";
import { BUILTIN_COMMANDS } from "../src/commands/builtins.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import { rebuildState } from "../src/session/resume.js";
import { FileSessionStore } from "../src/session/store.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-sessioncmd-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function project(): string {
  const root = join(base, `p${n++}`);
  const file = join(root, "src/math.js");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "export const add = (a, b) => a - b;\n");
  return root;
}

const signal = () => new AbortController().signal;

async function runtimeFor(
  root: string,
  model: FakeModelClient,
  extra: Partial<RuntimeOptions> = {},
): Promise<Runtime> {
  return Runtime.create({
    root,
    modelId: "claude-opus-5-5",
    model: async () => model,
    approver: new AutoApprover("once"),
    store: new FileSessionStore(root),
    settings: parseSettings({ executor: "host" }),
    mcp: false,
    hooks: false,
    profiles: [],
    ...extra,
  });
}

function chat(runtime: Runtime) {
  const store = new ChatStore({ model: "m", sandbox: "none" }, { paint: noColor });
  const run = (line: string) =>
    runCommand(line, { runtime, renderer: store, sessionPath: (id) => id });
  const said = () => store.getState().items.map((i) => i.text);
  return { run, said };
}

describe("/sessions (0.6)", () => {
  it("lists this project's sessions, newest first, and continues one in place", async () => {
    const root = project();
    const model = new FakeModelClient([
      reply([text("First answer.")]),
      reply([text("Second answer.")]),
      (request) => {
        // Back in the first session: its history goes with the new prompt.
        const all = JSON.stringify(request.messages);
        expect(all).toContain("first task");
        expect(all).not.toContain("second task");
        return reply([text("Continued.")]);
      },
    ]);
    const runtime = await runtimeFor(root, model);
    await runtime.runTurn("first task\nwith a second line", signal());
    const firstId = runtime.session?.id as string;
    runtime.newSession();
    await new Promise((r) => setTimeout(r, 20)); // a later file time
    await runtime.runTurn("second task", signal());

    const { run, said } = chat(runtime);
    await run("/sessions");
    const list = said().at(-1) as string;
    expect(list).toMatch(/1\. .* second task {2}\(open\)/);
    expect(list).toMatch(/2\. .* first task\n/);
    expect(list).toContain(`${firstId} · 1 turn`);

    await run("/sessions 2");
    expect(said().at(-1)).toMatch(new RegExp(`^Continuing session ${firstId} \\(2 messages`));
    expect(runtime.session?.id).toBe(firstId);
    await runtime.runTurn("go on", signal());
    expect(model.remaining).toBe(0);

    await run("/sessions nope");
    expect(said().at(-1)).toBe('There is no session "nope" in this project. Type /sessions.');
    await run(`/sessions ${firstId}`);
    expect(said().at(-1)).toBe(`Session ${firstId} is already open.`);
  });

  it("says so when there are none", async () => {
    const { run, said } = chat(await runtimeFor(project(), new FakeModelClient([])));
    await run("/sessions");
    expect(said()).toEqual(["There are no sessions in this project yet."]);
  });
});

describe("/models (0.6)", () => {
  function choices(clients: Record<string, FakeModelClient>) {
    return {
      resolve: (spec: string) => {
        const client = clients[spec];
        if (client === undefined) throw new Error(`Unknown model provider in "${spec}".`);
        return {
          spec,
          model: async () => client,
          info: spec.startsWith("ollama/")
            ? { contextWindow: 32_768, price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
            : { contextWindow: 200_000 },
        };
      },
      configured: ["ollama/qwen3-coder", "broken/x"],
    };
  }

  it("lists the known and configured models, and marks the current one", async () => {
    const runtime = await runtimeFor(project(), new FakeModelClient([]), {
      models: choices({ "ollama/qwen3-coder": new FakeModelClient([]) }),
    });
    const { run, said } = chat(runtime);
    await run("/models");
    const text = said()[0] as string;
    expect(text).toMatch(/● +\d+ {2}claude-opus-5-5 +1\.0M context, \$4\/\$20 per M tokens/);
    expect(text).toMatch(/ollama\/qwen3-coder +33k context, free/);
    expect(text).not.toContain("broken/x");
  });

  it("switches the main model for the next turn, records it, and sets the new window", async () => {
    const root = project();
    const first = new FakeModelClient([reply([text("From opus.")])]);
    const local = new FakeModelClient([reply([text("From qwen.")])]);
    const runtime = await runtimeFor(root, first, {
      models: choices({ "ollama/qwen3-coder": local }),
    });
    await runtime.runTurn("hello", signal());
    const { run, said } = chat(runtime);
    await run("/models ollama/qwen3-coder");
    expect(said().at(-1)).toBe(
      "The model is now ollama/qwen3-coder (33k context, free). The next turn uses it; the prompt cache starts again.",
    );
    expect(runtime.modelId).toBe("ollama/qwen3-coder");
    expect(runtime.limits.contextWindow).toBe(32_768);
    await runtime.runTurn("again", signal());
    expect(local.requests).toHaveLength(1);
    expect(first.remaining).toBe(0);

    const records = await new FileSessionStore(root).read(runtime.session?.id as string);
    expect(records.map((r) => r.type)).toContain("model");
    expect(rebuildState(records).start?.model).toBe("ollama/qwen3-coder");

    await run("/models ollama/qwen3-coder");
    expect(said().at(-1)).toBe("ollama/qwen3-coder is already the model.");
    await run("/models nothing/here");
    expect(said().at(-1)).toBe(
      'Cannot use nothing/here: Unknown model provider in "nothing/here".',
    );
    await run("/models 999");
    expect(said().at(-1)).toBe("There is no model 999 in the list. Type /models.");
  });

  it("an alias names the newest model of its family; without the option it cannot switch", async () => {
    const sonnet = new FakeModelClient([]);
    const runtime = await runtimeFor(project(), new FakeModelClient([]), {
      models: choices({ "claude-sonnet-5": sonnet }),
    });
    expect((await runtime.setModel("sonnet")).text).toMatch(/^The model is now claude-sonnet-5 /);
    const fixed = await runtimeFor(project(), new FakeModelClient([]));
    expect(await fixed.setModel("sonnet")).toEqual({
      ok: false,
      text: "This Garuda cannot switch models.",
    });
  });

  it("formats the facts of a model", () => {
    expect(modelFacts(200_000, undefined)).toBe("200k context, price unknown");
    expect(modelFacts(1_000_000, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })).toBe(
      "1.0M context, $3/$15 per M tokens",
    );
  });
});

describe("/export (0.6)", () => {
  it("writes the conversation as Markdown: prompts, answers, one line per tool call", async () => {
    const root = project();
    const model = new FakeModelClient([
      reply([
        text("I will fix it."),
        toolUse(
          "edit_file",
          { path: "src/math.js", old_string: "a - b", new_string: "a + b" },
          "e1",
        ),
      ]),
      reply([text("Fixed: `add` now adds.")]),
    ]);
    const runtime = await runtimeFor(root, model);
    await runtime.runUserCommand("echo hi", signal());
    await runtime.runTurn("fix @src/math.js", signal());
    const { run, said } = chat(runtime);
    const id = runtime.session?.id as string;
    await run("/export");
    expect(said().at(-1)).toBe(
      `Wrote the conversation to garuda-${id}.md. Secrets are redacted as in the session file.`,
    );
    const markdown = readFileSync(join(root, `garuda-${id}.md`), "utf8");
    expect(markdown).toContain(`# Garuda session ${id}`);
    expect(markdown).toContain("- Model: claude-opus-5-5");
    expect(markdown).toMatch(/## You · \d{4}-\d\d-\d\d \d\d:\d\d\n\nfix @src\/math\.js\n/);
    expect(markdown).toContain("> Ran `echo hi` before this message.");
    expect(markdown).toContain("> Attached src/math.js");
    expect(markdown).toContain("## Garuda\n\nI will fix it.\n\n- `edit_file src/math.js` →");
    expect(markdown).toContain("Fixed: `add` now adds.");
    // Notes and file text stay out.
    expect(markdown).not.toContain("a - b;");

    await run("/export");
    expect(said().at(-1)).toBe(
      `garuda-${id}.md already exists. Give another name: /export <file>.`,
    );
    await run("/export notes/chat.md");
    expect(existsSync(join(root, "notes/chat.md"))).toBe(true);
    await run("/export ../out.md");
    expect(said().at(-1)).toBe("../out.md is outside the working folder.");
  });

  it("marks undo, compaction, a model change and a stopped turn", () => {
    const t = "2026-09-26T10:15:00.000Z";
    const md = sessionMarkdown(
      [
        { t, type: "snapshot", tree: "x", messages: 0, prompt: "try this", durationMs: 1 },
        {
          t,
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "try this" }] },
        },
        { t, type: "end", stopReason: "interrupted", steps: 0 },
        { t, type: "undo", after: "y" },
        {
          t,
          type: "model",
          sessionId: "s",
          root: "/r",
          version: "v",
          model: "ollama/q",
          executor: "host",
          isolation: "none",
          limits: { maxSteps: 1, tokenBudget: 1, contextWindow: 1 },
        },
        { t, type: "compaction", stage: "trim", beforeTokens: 2, afterTokens: 1, messages: [] },
      ],
      "s",
    );
    expect(md).toContain("_The turn stopped: interrupted._");
    expect(md).toContain('_/undo: the turn "try this" was taken back._');
    expect(md).toContain("_The model changed to ollama/q._");
    expect(md).toContain("_The conversation was compacted here to fit the context window._");
  });

  it("with no conversation, and a file name is never overwritten", async () => {
    const { run, said } = chat(await runtimeFor(project(), new FakeModelClient([])));
    await run("/export");
    expect(said()).toEqual(["There is no conversation to export yet."]);
    const root = project();
    writeFileSync(join(root, "x.md"), "mine");
    expect(await writeExport(root, "s", "new", "x.md")).toEqual({
      problem: "x.md already exists. Give another name: /export <file>.",
    });
    expect(readFileSync(join(root, "x.md"), "utf8")).toBe("mine");
  });

  it("the three are built-in commands", () => {
    expect(BUILTIN_COMMANDS).toEqual(expect.arrayContaining(["sessions", "models", "export"]));
  });
});

describe("/compact (0.8)", () => {
  it("summarises the older turns now, with the focus text, and keeps the last 4 steps", async () => {
    const root = project();
    const answers = [1, 2, 3, 4, 5].map((i) => reply([text(`Answer ${i}.`)]));
    let summaryRequest = "";
    const model = new FakeModelClient([
      ...answers,
      (request) => {
        summaryRequest = JSON.stringify(request.messages);
        expect(request.tools).toEqual([]);
        return reply([text("The user asked five things.")]);
      },
    ]);
    const runtime = await runtimeFor(root, model);
    for (const i of [1, 2, 3, 4, 5]) await runtime.runTurn(`task ${i}`, signal());
    const { run, said } = chat(runtime);

    await run("/compact keep the API decisions");
    expect(summaryRequest).toContain("keep, above all: keep the API decisions");
    expect(summaryRequest).toContain("task 1");
    expect(said().at(-1)).toMatch(/^Context compacted: .* → about .* tokens · \$\d+\.\d{4}\./);
    const messages = runtime.session?.messages ?? [];
    expect(JSON.stringify(messages[0])).toContain("The user asked five things.");
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(4);
    expect(JSON.stringify(messages)).not.toContain("Answer 1.");
    expect(model.remaining).toBe(0);

    // The journal has the compaction: a resume sees the compacted conversation.
    const records = await new FileSessionStore(root).read(runtime.session?.id as string);
    expect(rebuildState(records).messages).toHaveLength(messages.length);
  });

  it("too little to compact, no session, and a stop that changes nothing", async () => {
    const root = project();
    const model = new FakeModelClient([reply([text("One.")])]);
    const runtime = await runtimeFor(root, model);
    const { run, said } = chat(runtime);
    await run("/compact");
    expect(said().at(-1)).toBe("No session yet: there is nothing to compact.");
    await runtime.runTurn("one task", signal());
    await run("/compact");
    expect(said().at(-1)).toMatch(/^Too little to compact: the last 4 steps always stay in full\./);

    const five = new FakeModelClient([1, 2, 3, 4, 5].map((i) => reply([text(`A${i}`)])));
    const other = await runtimeFor(project(), five);
    for (const i of [1, 2, 3, 4, 5]) await other.runTurn(`t${i}`, signal());
    const before = JSON.stringify(other.session?.messages);
    const stop = new AbortController();
    stop.abort();
    const store = new ChatStore({ model: "m", sandbox: "none" }, { paint: noColor });
    await runCommand("/compact", {
      runtime: other,
      renderer: store,
      sessionPath: (id) => id,
      signal: stop.signal,
    });
    expect(store.getState().items.at(-1)?.text).toBe(
      "Compaction stopped. The conversation did not change.",
    );
    expect(JSON.stringify(other.session?.messages)).toBe(before);
  });

  it("is a built-in command with a help line", () => {
    expect(BUILTIN_COMMANDS).toContain("compact");
  });
});
