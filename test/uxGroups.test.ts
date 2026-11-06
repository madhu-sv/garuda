import { describe, expect, it } from "vitest";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { groups, groupTargets } from "../src/cli/chat/toolGroups.js";
import type { ToolUseBlock } from "../src/model/types.js";

/** UX U4 (docs/lld/ux.md): grouped tool lines. */

const store = () =>
  new ChatStore({ model: "m", sandbox: "sandbox test" }, { paint: noColor, columns: () => 100 });
const texts = (s: ChatStore) => s.getState().items.map((i) => i.text);
let n = 0;
const call = (name: string, input: Record<string, unknown>): ToolUseBlock => ({
  type: "tool_use",
  id: `c${++n}`,
  name,
  input,
});
function run(s: ChatStore, c: ToolUseBlock, ok = true) {
  s.event({ type: "tool_call", call: c });
  s.event({
    type: "tool_result",
    call: c,
    outcome: { content: ok ? "1\tx" : "Error: no such file", isError: !ok },
  });
}

describe("grouped tool lines", () => {
  it("reads in a row become one line; a command keeps its own line, after them", () => {
    const s = store();
    s.begin("go");
    for (const path of ["src/a.ts", "src/b.ts", "src/c.ts"]) run(s, call("read_file", { path }));
    expect(s.getState().group).toBe("● Read 3 files  src/a.ts, src/b.ts, src/c.ts");
    run(s, call("bash", { command: "pnpm test" }));
    s.end({});
    const shown = texts(s).slice(1);
    expect(shown[0]).toBe("● Read 3 files  src/a.ts, src/b.ts, src/c.ts");
    expect(shown[1]?.startsWith("● bash pnpm test\n")).toBe(true);
    expect(shown).toHaveLength(2);
  });

  it("a failed call is never grouped; the reads before and after it are separate groups", () => {
    const s = store();
    s.begin("go");
    run(s, call("read_file", { path: "a" }));
    run(s, call("read_file", { path: "b" }));
    run(s, call("read_file", { path: "missing" }), false);
    run(s, call("read_file", { path: "c" }));
    s.end({});
    const shown = texts(s).slice(1);
    expect(shown[0]).toBe("● Read 2 files  a, b");
    expect(shown[1]).toMatch(/^● read_file missing\n {2}⎿ /);
    // A lone call keeps the line it always had.
    expect(shown[2]).toBe("● read_file c\n  ⎿ 1 line(s)");
  });

  it("another tool, and the model's text, close the group in order", () => {
    const s = store();
    s.begin("go");
    run(s, call("read_file", { path: "a" }));
    run(s, call("read_file", { path: "b" }));
    run(s, call("grep", { pattern: "price" }));
    run(s, call("grep", { pattern: "cache" }));
    s.event({ type: "text_delta", text: "Found it.\n\n" });
    expect(texts(s).slice(1)).toEqual([
      "● Read 2 files  a, b",
      "● Searched 2 times  /price/, /cache/",
      "Found it.",
    ]);
    expect(s.getState().group).toBeUndefined();
  });

  it("only read-only tools group; the target list is cut with a count", () => {
    expect(["read_file", "glob", "grep", "find_symbol"].every(groups)).toBe(true);
    expect(["bash", "edit_file", "write_file", "web_fetch", "todo_write"].some(groups)).toBe(false);
    const calls = ["a.ts", "b.ts", "c.ts", "d.ts"].map((path) => call("read_file", { path }));
    expect(groupTargets(calls, 14)).toBe("a.ts, b.ts, +2");
    expect(groupTargets(calls, 12)).toBe("a.ts, +3");
    expect(groupTargets(calls, 100)).toBe("a.ts, b.ts, c.ts, d.ts");
  });
});
