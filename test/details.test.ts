import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Runtime } from "../src/app/runtime.js";
import { runCommand } from "../src/cli/chat/commands.js";
import { CommandArgs } from "../src/cli/chat/controller.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { PlainRenderer, type Renderer } from "../src/cli/renderer.js";
import { BUILTIN_COMMANDS } from "../src/commands/builtins.js";
import { toolUse } from "../src/model/fake.js";

/** /details (0.9): the result line under each tool call can be hidden; errors always show. */

const read = toolUse("read_file", { path: "src/a.js" }, "r1");
const bash = toolUse("bash", { command: "npm test" }, "b1");
const ok = {
  type: "tool_result" as const,
  call: read,
  outcome: { content: "a\nb\n", isError: false },
};
const failed = {
  type: "tool_result" as const,
  call: bash,
  outcome: { content: "Exit code: 1\nboom", isError: true },
};
const run = (renderer: Renderer, line: string) =>
  runCommand(line, { runtime: {} as Runtime, renderer, sessionPath: (id) => id });

describe("/details (0.9)", () => {
  it("the Ink chat hides result lines after /details, but not a failed call's", async () => {
    const store = new ChatStore({ model: "m", sandbox: "s" }, { paint: noColor });
    const tools = () =>
      store
        .getState()
        .items.filter((i) => i.kind === "tool")
        .map((i) => i.text);
    store.event(ok);
    expect(tools()[0]).toContain("⎿ 3 line(s)");

    await run(store, "/details");
    expect(store.getState().items.at(-1)?.text).toMatch(/^Details off: tool calls show one line/);
    store.event(ok);
    store.event(failed);
    expect(tools()[1]).toBe("● read_file src/a.js");
    expect(tools()[2]).toContain("⎿");

    await run(store, "/details on");
    store.event(ok);
    expect(tools()[3]).toContain("⎿ 3 line(s)");
    await run(store, "/details maybe");
    expect(store.getState().items.at(-1)?.text).toBe("Use: /details, /details on or /details off.");
  });

  it("the plain chat does the same", async () => {
    let err = "";
    const stream = (write: (s: string) => void) =>
      new Writable({
        write(chunk, _e, done) {
          write(String(chunk));
          done();
        },
      });
    const plain = new PlainRenderer(
      { out: stream(() => {}), err: stream((s) => (err += s)) },
      false,
    );
    await run(plain, "/details off");
    err = "";
    plain.event({ type: "tool_call", call: read });
    plain.event(ok);
    plain.event({ type: "tool_call", call: bash });
    plain.event(failed);
    expect(err).not.toContain("line(s)");
    expect(err).toContain("● read_file src/a.js");
    expect(err).toMatch(/⎿ .*Exit code: 1/);
  });

  it("a built-in command; Tab offers on and off", () => {
    expect(BUILTIN_COMMANDS).toContain("details");
    const args = new CommandArgs({} as Runtime);
    expect(args.choices("details", []).map((c) => c.value)).toEqual(["on", "off"]);
    expect(args.choices("details", ["on"])).toEqual([]);
  });
});
