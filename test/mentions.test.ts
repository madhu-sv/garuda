import {
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
import { attachMentions, mentionTokens } from "../src/app/mentions.js";
import { Runtime } from "../src/app/runtime.js";
import { complete, fuzzyFiles, rootFiles, rootLister } from "../src/cli/chat/complete.js";
import { CommandArgs } from "../src/cli/chat/controller.js";
import { ChatStore } from "../src/cli/chat/store.js";
import type { AgentEvent } from "../src/loop/runAgent.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { TextBlock } from "../src/model/types.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import { FileTracker } from "../src/session/fileTracker.js";
import { FileSessionStore } from "../src/session/store.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-mentions-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function project(files: Record<string, string> = {}): string {
  const root = join(base, `p${n++}`);
  const all = {
    "src/math.js": "export const add = (a, b) => a - b;\n",
    "src/util/str.js": "export const up = (s) => s.toUpperCase();\n",
    ".env": "SECRET=1\n",
    "README.md": "# Demo\n",
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

const signal = () => new AbortController().signal;

describe("@path mentions (0.6)", () => {
  it("finds @words at the start or after a space, and drops trailing punctuation", () => {
    expect(mentionTokens("fix @src/math.js, then @README.md. mail me@x.com @@ @")).toEqual([
      "src/math.js",
      "README.md",
    ]);
  });

  it("attaches files numbered like read_file, folders as lists; marks files as read", async () => {
    const root = project();
    const files = new FileTracker();
    const { attachments, skipped } = await attachMentions(
      "look at @src/math.js and @src/ and @nothing-here and @.env and @../outside/x",
      root,
      files,
    );
    expect(attachments.map((a) => a.summary)).toEqual(["src/math.js (1 line)", "src/ (2 entries)"]);
    expect(attachments[0]?.text).toBe(
      "The user attached src/math.js:\n     1\texport const add = (a, b) => a - b;",
    );
    expect(attachments[1]?.text).toBe(
      "The user attached the folder src/ (its entries):\nsrc/math.js\nsrc/util/",
    );
    expect(skipped).toEqual([
      "@.env: a sensitive file (read_file refuses it too)",
      "@../outside/x: outside the working folder",
    ]);
    expect(files.status(join(root, "src/math.js"), readFileSync(join(root, "src/math.js")))).toBe(
      "current",
    );
  });

  it("cuts a long file at 2 000 lines and says how to read the rest", async () => {
    const root = project({
      "big.txt": `${Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n")}\n`,
    });
    const { attachments } = await attachMentions("@big.txt", root, new FileTracker());
    expect(attachments[0]?.summary).toBe("big.txt (2000 of 2500 lines)");
    expect(attachments[0]?.text).toContain(
      "[Lines 1–2000 of 2500. Read the rest with read_file, offset 2001.]",
    );
  });

  it("in a turn: the file goes with the message, the user sees a notice, and the model can edit at once", async () => {
    const root = project();
    const model = new FakeModelClient([
      (request) => {
        const blocks = request.messages.at(-1)?.content as TextBlock[];
        expect(blocks[0]?.text).toBe("fix @src/math.js");
        expect(blocks[1]?.text).toContain("The user attached src/math.js:");
        // No read_file first: the attachment counts as a read.
        return reply([
          toolUse(
            "edit_file",
            { path: "src/math.js", old_string: "a - b", new_string: "a + b" },
            "e1",
          ),
        ]);
      },
      reply([text("Fixed.")]),
    ]);
    const events: AgentEvent[] = [];
    const runtime = await Runtime.create({
      root,
      modelId: "fake",
      model: async () => model,
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      profiles: [],
      onEvent: (e) => events.push(e),
    });
    await runtime.runTurn("fix @src/math.js", signal());
    expect(readFileSync(join(root, "src/math.js"), "utf8")).toContain("a + b");
    expect(events.find((e) => e.type === "notice")).toEqual({
      type: "notice",
      text: "Attached src/math.js (1 line).",
    });
  });
});

describe("!command (0.6)", () => {
  async function runtimeFor(
    root: string,
    model: FakeModelClient,
    settings: Record<string, unknown> = {},
  ) {
    return Runtime.create({
      root,
      modelId: "fake",
      model: async () => model,
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host", ...settings }),
      mcp: false,
      hooks: false,
      profiles: [],
    });
  }

  it("runs like the bash tool; the output goes with the next message as a note", async () => {
    const root = project();
    const model = new FakeModelClient([
      (request) => {
        const all = JSON.stringify(request.messages.at(-1));
        expect(all).toContain("The user ran a command in the chat (not you):");
        expect(all).toContain("$ cat README.md");
        expect(all).toContain("# Demo");
        return reply([text("I see the readme.")]);
      },
    ]);
    const runtime = await runtimeFor(root, model);
    const result = await runtime.runUserCommand("cat README.md", signal());
    expect(result.isError).toBe(false);
    expect(result.text).toContain("# Demo");
    // No session file for a command alone.
    expect(runtime.session).toBeUndefined();
    await runtime.runTurn("What did you see?", signal());
    expect(model.remaining).toBe(0);
  });

  it("/new does not carry the old session's command notes (0.14, review)", async () => {
    const root = project();
    const model = new FakeModelClient([
      (request) => {
        expect(JSON.stringify(request.messages)).not.toContain("The user ran a command");
        return reply([text("Fresh.")]);
      },
    ]);
    const runtime = await runtimeFor(root, model);
    await runtime.runUserCommand("cat README.md", signal());
    runtime.newSession();
    await runtime.runTurn("hello", signal());
    expect(model.remaining).toBe(0);
  });

  it("deny rules hold for the user's command too", async () => {
    const root = project();
    const runtime = await runtimeFor(root, new FakeModelClient([]), {
      permissions: { deny: ["bash(rm*)"] },
    });
    const result = await runtime.runUserCommand("rm README.md", signal());
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/deny rule/);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("# Demo\n");
  });
});

describe("Tab completion (0.6)", () => {
  const sources = (root: string) => ({
    commands: ["help", "hooks", "review", "git:commit", "git:push"],
    list: rootLister(root),
  });

  it("completes /commands at the start of the line", () => {
    const root = project();
    expect(complete("/rev", 4, sources(root))).toEqual({
      text: "/review ",
      cursor: 8,
      candidates: [],
    });
    expect(complete("/h", 2, sources(root))).toEqual({
      text: "/h",
      cursor: 2,
      candidates: ["/help", "/hooks"],
    });
    expect(complete("/git", 4, sources(root))).toEqual({
      text: "/git:",
      cursor: 5,
      candidates: ["/git:commit", "/git:push"],
    });
    // Not at the start: no command completion.
    expect(complete("say /rev", 8, sources(root))).toBeUndefined();
  });

  it("completes @paths anywhere, folder by folder, hidden entries only on a dot", () => {
    const root = project();
    const s = sources(root);
    expect(complete("fix @sr", 7, s)).toEqual({ text: "fix @src/", cursor: 9, candidates: [] });
    expect(complete("fix @src/m", 10, s)).toEqual({
      text: "fix @src/math.js",
      cursor: 16,
      candidates: [],
    });
    expect(complete("@src/", 5, s)?.candidates).toEqual(["@src/math.js", "@src/util/"]);
    expect(complete("@", 1, s)?.candidates).toEqual(["@README.md", "@src/"]);
    expect(complete("@.e", 3, s)?.text).toBe("@.env");
    expect(complete("@../", 4, s)).toBeUndefined();
    expect(complete("plain words", 11, s)).toBeUndefined();
  });

  it("Tab in the chat store sets the line and lists several matches", () => {
    const root = project();
    const store = new ChatStore({ model: "m", sandbox: "s" }, { paint: (_s, t) => t });
    store.completer = (t, c) => complete(t, c, sources(root));
    store.editLine({ type: "insert", text: "/h" });
    store.completeLine();
    expect(JSON.stringify(store.getState().items)).toContain("/help  /hooks");
    store.editLine({ type: "insert", text: "o" });
    store.completeLine();
    expect(store.getState().editor.text).toBe("/hooks ");
  });
});

describe("Tab completion of command arguments (0.8)", () => {
  const base = { commands: ["sessions", "models"], list: () => [] };

  it("completes the next argument from the command's choices; hints go one per line", () => {
    const args = (command: string, before: readonly string[]) =>
      command === "sessions" && before.length === 0
        ? [
            { value: "rename" },
            { value: "20260928-1000-aaaa", hint: "API work" },
            { value: "20260928-1100-bbbb", hint: "first task" },
          ]
        : [];
    const s = { ...base, args };
    expect(complete("/sessions ren", 13, s)).toEqual({
      text: "/sessions rename ",
      cursor: 17,
      candidates: [],
    });
    expect(complete("/sessions 2026", 14, s)).toEqual({
      text: "/sessions 20260928-1",
      cursor: 20,
      lines: true,
      candidates: ["20260928-1000-aaaa  API work", "20260928-1100-bbbb  first task"],
    });
    // A later argument, another command, or no match: nothing.
    expect(complete("/sessions rename x", 18, s)).toBeUndefined();
    expect(complete("/models x", 9, s)).toBeUndefined();
    expect(complete("/sessions zz", 12, s)).toBeUndefined();
    // @paths still win inside a command line.
    expect(complete("/sessions @", 11, { ...s, list: () => ["a.md"] })?.text).toBe(
      "/sessions @a.md",
    );
  });

  it("CommandArgs gives sessions with titles, models, jobs and fixed words", async () => {
    const root = project();
    const model = new FakeModelClient([reply([text("One.")])]);
    const runtime = await Runtime.create({
      root,
      modelId: "claude-opus-5-5",
      model: async () => model,
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "host" }),
      mcp: false,
      hooks: false,
      profiles: [],
    });
    await runtime.runTurn("fix the parser", new AbortController().signal);
    const id = runtime.session?.id as string;
    const args = new CommandArgs(runtime);
    await args.refresh();
    const s = {
      commands: ["sessions"],
      list: () => [],
      args: (c: string, b: readonly string[]) => args.choices(c, b),
    };
    expect(complete("/sessions delete ", 17, s)?.text).toBe(`/sessions delete ${id} `);
    expect(complete("/sessions ", 10, s)?.candidates).toEqual([
      `${id}  fix the parser`,
      "delete",
      "rename",
    ]);
    expect(complete("/models son", 11, s)?.text).toBe("/models sonnet ");
    expect(complete("/models claude-opus", 19, s)?.candidates.length).toBeGreaterThan(0);
    expect(complete("/models opus x", 14, s)).toBeUndefined();
    expect(complete("/jobs ", 6, s)?.candidates).toEqual(["cancel", "delete"]);
    expect(complete("/jobs d", 7, s)?.text).toBe("/jobs delete ");
    expect(complete("/diff l", 7, s)?.text).toBe("/diff last ");
    expect(complete("/lsp install p", 14, s)?.text).toBe("/lsp install python ");
    expect(complete("/mcp lo", 7, s)?.text).toBe("/mcp logout ");
    expect(complete("/help x", 7, s)).toBeUndefined();
  });

  it("Tab in the chat store lists hinted choices one per line", () => {
    const store = new ChatStore({ model: "m", sandbox: "s" }, { paint: (_s, t) => t });
    store.completer = (t, c) =>
      complete(t, c, {
        ...base,
        args: () => [
          { value: "a1", hint: "one" },
          { value: "a2", hint: "two" },
        ],
      });
    store.editLine({ type: "insert", text: "/sessions a" });
    store.completeLine();
    expect(store.getState().items.at(-1)?.text).toBe("a1  one\na2  two");
  });
});

describe("fuzzy @ search (0.8)", () => {
  const files = [
    "src/app/runtime.ts",
    "src/app/mentions.ts",
    "src/cli/repl.ts",
    "test/runtime.test.ts",
    "docs/lld/runtime-and-loop.md",
    "README.md",
  ];

  it("ranks matches in the file name, runs and word starts first", () => {
    expect(fuzzyFiles("rntm", files, 10)).toEqual([
      "src/app/runtime.ts",
      "test/runtime.test.ts",
      "docs/lld/runtime-and-loop.md",
    ]);
    expect(fuzzyFiles("app/men", files, 10)).toEqual(["src/app/mentions.ts"]);
    expect(fuzzyFiles("README", files, 10)).toEqual(["README.md"]);
    expect(fuzzyFiles("zzz", files, 10)).toEqual([]);
    expect(fuzzyFiles("t", files, 2)).toHaveLength(2);
  });

  it("a short file name that the query starts beats a long name with the letters spread (live test)", () => {
    const live = [
      "patches/0045-mcp-keep-the-OAuth-discovery-state-SEP-2352.patch",
      "patches/0058-fix-chat-start-tips-name-the-new-keys-Enter-typed-fa.patch",
      "patches/0037-0.4-plan-mode.patch",
      "test/math.test.js",
      "src/math.js",
    ];
    expect(fuzzyFiles("mth", live, 2)).toEqual(["src/math.js", "test/math.test.js"]);
  });

  it("only when the prefix finds nothing: one match completes, several are listed", () => {
    const s = {
      commands: [],
      list: (folder: string) => (folder === "" ? ["src/", "test/"] : []),
      files: () => files,
    };
    // A prefix match wins: no fuzzy search.
    expect(complete("@sr", 3, s)?.text).toBe("@src/");
    expect(complete("fix @app/men now", 12, s)).toEqual({
      text: "fix @src/app/mentions.ts now",
      cursor: 24,
      candidates: [],
    });
    expect(complete("@rntm", 5, s)).toEqual({
      text: "@rntm",
      cursor: 5,
      lines: true,
      candidates: ["@src/app/runtime.ts", "@test/runtime.test.ts", "@docs/lld/runtime-and-loop.md"],
    });
    expect(complete("@qqq", 4, s)).toBeUndefined();
  });

  it("walks the root: no hidden entries, no node_modules or dist, no links; kept for 10 s", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "garuda-fuzzy-")));
    try {
      for (const f of [
        "src/a.ts",
        "node_modules/x/i.js",
        "dist/a.js",
        ".env",
        ".git/HEAD",
        "src/.hid/b.ts",
      ]) {
        mkdirSync(dirname(join(root, f)), { recursive: true });
        writeFileSync(join(root, f), "");
      }
      symlinkSync(join(root, "src"), join(root, "link"));
      let now = 0;
      const list = rootFiles(root, () => now);
      expect(list()).toEqual(["src/a.ts"]);
      writeFileSync(join(root, "src/b.ts"), "");
      expect(list()).toEqual(["src/a.ts"]);
      now = 10_000;
      expect([...list()].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
