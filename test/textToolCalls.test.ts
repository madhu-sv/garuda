import { describe, expect, it } from "vitest";
import { mayBeToolCall, textToolCalls } from "../src/model/textToolCalls.js";

const tools = new Set(["glob", "read_file"]);

describe("tool calls written as text", () => {
  it("reads one call, with 'arguments' or 'parameters'", () => {
    expect(textToolCalls('{"name": "glob", "arguments": {"pattern": "**/README"}}', tools)).toEqual(
      [{ name: "glob", input: { pattern: "**/README" } }],
    );
    expect(textToolCalls('  {"name":"read_file","parameters":{"path":"a"}}\n', tools)).toEqual([
      { name: "read_file", input: { path: "a" } },
    ]);
    expect(textToolCalls('{"name":"glob"}', tools)).toEqual([{ name: "glob", input: {} }]);
  });

  it("reads arguments sent as a JSON string", () => {
    expect(textToolCalls('{"name":"glob","arguments":"{\\"pattern\\":\\"*\\"}"}', tools)).toEqual([
      { name: "glob", input: { pattern: "*" } },
    ]);
  });

  it("reads fences, tags, arrays and one call per line", () => {
    const one = '{"name":"glob","arguments":{"pattern":"*"}}';
    const two = '{"name":"read_file","arguments":{"path":"a"}}';
    const both = [
      { name: "glob", input: { pattern: "*" } },
      { name: "read_file", input: { path: "a" } },
    ];
    expect(textToolCalls(`\`\`\`json\n${one}\n\`\`\``, tools)).toHaveLength(1);
    expect(textToolCalls(`\`\`\`\n${one}\n\`\`\``, tools)).toHaveLength(1);
    expect(textToolCalls(`<tool_call>\n${one}\n</tool_call>`, tools)).toHaveLength(1);
    expect(
      textToolCalls(`<tool_call>${one}</tool_call>\n<tool_call>${two}</tool_call>`, tools),
    ).toEqual(both);
    expect(textToolCalls(`[${one}, ${two}]`, tools)).toEqual(both);
    expect(textToolCalls(`${one}\n${two}`, tools)).toEqual(both);
  });

  it("keeps text as text when any rule fails", () => {
    const call = '{"name":"glob","arguments":{"pattern":"*"}}';
    // Inside prose: maybe an example, or text quoted from a file.
    expect(textToolCalls(`I will run ${call}`, tools)).toBeUndefined();
    expect(textToolCalls(`${call}\nThen I will read it.`, tools)).toBeUndefined();
    expect(textToolCalls(`\`\`\`json\n${call}\n\`\`\`\nDone.`, tools)).toBeUndefined();
    // Not a tool of this request.
    expect(textToolCalls('{"name":"rm_rf","arguments":{}}', tools)).toBeUndefined();
    // One good call and one bad call: none runs.
    expect(textToolCalls(`[${call}, {"name":"nope"}]`, tools)).toBeUndefined();
    // Arguments that are not an object, and plain JSON answers.
    expect(textToolCalls('{"name":"glob","arguments":[1]}', tools)).toBeUndefined();
    expect(textToolCalls('{"name":"glob","arguments":"oops"}', tools)).toBeUndefined();
    expect(textToolCalls('{"version": "1.0"}', tools)).toBeUndefined();
    expect(textToolCalls("```python\nprint(1)\n```", tools)).toBeUndefined();
    expect(textToolCalls("", tools)).toBeUndefined();
    expect(textToolCalls("[]", tools)).toBeUndefined();
  });

  it("holds streamed text only while it can still be a call", () => {
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
});
