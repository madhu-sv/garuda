import { describe, expect, it } from "vitest";
import {
  extractTextToolCalls,
  mayBeToolCall,
  StreamHold,
  type TextToolCallMode,
} from "../src/model/textToolCalls.js";

const tools = new Set(["glob", "read_file"]);
const calls = (text: string, mode: TextToolCallMode = "whole") =>
  extractTextToolCalls(text, tools, mode)?.calls;

const GLOB = '{"name":"glob","arguments":{"pattern":"*"}}';
const READ = '{"name":"read_file","arguments":{"path":"a"}}';
const BOTH = [
  { name: "glob", input: { pattern: "*" } },
  { name: "read_file", input: { path: "a" } },
];

describe("tool calls written as text: whole mode", () => {
  it("reads one call, with 'arguments' or 'parameters'", () => {
    expect(calls('{"name": "glob", "arguments": {"pattern": "**/README"}}')).toEqual([
      { name: "glob", input: { pattern: "**/README" } },
    ]);
    expect(calls('  {"name":"read_file","parameters":{"path":"a"}}\n')).toEqual([
      { name: "read_file", input: { path: "a" } },
    ]);
    expect(calls('{"name":"glob"}')).toEqual([{ name: "glob", input: {} }]);
    expect(extractTextToolCalls(GLOB, tools)?.text).toBe("");
  });

  it("reads arguments sent as a JSON string", () => {
    expect(calls('{"name":"glob","arguments":"{\\"pattern\\":\\"*\\"}"}')).toEqual([
      { name: "glob", input: { pattern: "*" } },
    ]);
  });

  it("reads fences, tags, arrays and one call per line", () => {
    expect(calls(`\`\`\`json\n${GLOB}\n\`\`\``)).toHaveLength(1);
    expect(calls(`\`\`\`\n${GLOB}\n\`\`\``)).toHaveLength(1);
    expect(calls(`<tool_call>\n${GLOB}\n</tool_call>`)).toHaveLength(1);
    expect(calls(`<tool_call>${GLOB}</tool_call>\n<tool_call>${READ}</tool_call>`)).toEqual(BOTH);
    expect(calls(`[${GLOB}, ${READ}]`)).toEqual(BOTH);
    expect(calls(`${GLOB}\n${READ}`)).toEqual(BOTH);
  });

  it("keeps text as text when any rule fails", () => {
    // Prose around the call: maybe an example, or text quoted from a file.
    expect(calls(`I will run ${GLOB}`)).toBeUndefined();
    expect(calls(`${GLOB}\nThen I will read it.`)).toBeUndefined();
    expect(calls(`\`\`\`json\n${GLOB}\n\`\`\`\nDone.`)).toBeUndefined();
    // Not a tool of this request.
    expect(calls('{"name":"rm_rf","arguments":{}}')).toBeUndefined();
    // One good call and one bad call: none runs.
    expect(calls(`[${GLOB}, {"name":"nope"}]`)).toBeUndefined();
    // Arguments that are not an object, and plain JSON answers.
    expect(calls('{"name":"glob","arguments":[1]}')).toBeUndefined();
    expect(calls('{"name":"glob","arguments":"oops"}')).toBeUndefined();
    expect(calls('{"version": "1.0"}')).toBeUndefined();
    expect(calls("```python\nprint(1)\n```")).toBeUndefined();
    expect(calls("")).toBeUndefined();
    expect(calls("[]")).toBeUndefined();
  });

  it("finds nothing in off mode or without tools", () => {
    expect(calls(GLOB, "off")).toBeUndefined();
    expect(extractTextToolCalls(GLOB, new Set(), "whole")).toBeUndefined();
  });
});

describe("tool calls written as text: lines mode", () => {
  it("reads calls on their own lines between prose, and keeps the prose", () => {
    const reply = `Sure, I'll list the files.\n\n  ${GLOB}\n\nAfter that, I'll read the README.`;
    expect(extractTextToolCalls(reply, tools, "lines")).toEqual({
      calls: [BOTH[0]],
      text: "Sure, I'll list the files.\n\nAfter that, I'll read the README.",
    });
  });

  it("reads fences, tags and JSON over several lines", () => {
    const pretty = JSON.stringify(JSON.parse(READ), null, 2);
    const reply = [
      "First:",
      "```json",
      GLOB,
      "```",
      "Then:",
      pretty,
      `<tool_call>${READ}</tool_call>`,
    ].join("\n");
    expect(extractTextToolCalls(reply, tools, "lines")).toEqual({
      calls: [BOTH[0], BOTH[1], BOTH[1]],
      text: "First:\nThen:",
    });
  });

  it("never reads a call in the middle of a sentence, in another fence, or to another tool", () => {
    expect(calls(`I could run ${GLOB} now.`, "lines")).toBeUndefined();
    expect(calls(`Example:\n\`\`\`python\n${GLOB}\n\`\`\``, "lines")).toBeUndefined();
    expect(calls('Run:\n{"name":"rm_rf","arguments":{}}', "lines")).toBeUndefined();
    // Another tool's line stays text; a good call on its own line still runs.
    expect(
      extractTextToolCalls(`{"name":"rm_rf","arguments":{}}\n${GLOB}`, tools, "lines"),
    ).toEqual({ calls: [BOTH[0]], text: '{"name":"rm_rf","arguments":{}}' });
  });
});

describe("holding streamed text", () => {
  it("holds text only while it can still be a call", () => {
    for (const text of [
      "",
      "  ",
      "{",
      '{"na',
      "[",
      "`",
      "``",
      "```",
      "```js",
      "```json\n{",
      "<tool",
      "<tool_call>\n{",
    ])
      expect(mayBeToolCall(text), JSON.stringify(text)).toBe(true);
    for (const text of ["I", "Let me look", "```python\n", "<b>", "- item"])
      expect(mayBeToolCall(text), JSON.stringify(text)).toBe(false);
  });

  const play = (mode: TextToolCallMode, parts: string[]) => {
    const hold = new StreamHold(mode);
    const shown = parts.map((p) => hold.push(p));
    return { shown, rest: hold.rest() };
  };

  it("whole mode: holds a reply that starts like a call, and releases other text", () => {
    expect(play("whole", ['{"name":', '"glob"}'])).toEqual({
      shown: ["", ""],
      rest: '{"name":"glob"}',
    });
    expect(play("whole", ["``", "`python\n", "x"])).toEqual({
      shown: ["", "```python\n", "x"],
      rest: "",
    });
  });

  it("lines mode: shows prose at once, and holds from the first line that can start a call", () => {
    expect(play("lines", ["Sure, I'll ", 'look.\n\n  {"name"', ': "glob"}\nAfter.'])).toEqual({
      shown: ["Sure, I'll ", "look.\n\n", ""],
      rest: '  {"name": "glob"}\nAfter.',
    });
    expect(play("lines", ["- a\n", "- b"])).toEqual({ shown: ["- a\n", "- b"], rest: "" });
  });

  it("off mode: shows everything", () => {
    expect(play("off", ["{", "}"])).toEqual({ shown: ["{", "}"], rest: "" });
  });
});
