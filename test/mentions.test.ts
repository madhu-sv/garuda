import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { attachMentions, mentionTokens } from "../src/app/mentions.js";
import { Runtime } from "../src/app/runtime.js";
import { complete, rootLister } from "../src/cli/chat/complete.js";
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
