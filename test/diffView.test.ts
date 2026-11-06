import { describe, expect, it } from "vitest";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import {
  type DiffPaint,
  hunkCount,
  SIDE_BY_SIDE_COLUMNS,
  sideBySide,
  terminalDiff,
  tokens,
  unifiedDiff,
  wordDiff,
} from "../src/cli/diffView.js";
import type { ApprovalRequest } from "../src/permissions/types.js";

/** UX U5 (docs/lld/ux.md): word marks and the side-by-side diff. */

/** Marks as text: [changed], <r>…</r> for red, <g>…</g> for green, so tests see the styles. */
const marks: DiffPaint = (styles, text) => {
  const inner = styles.includes("inverse") ? `[${text}]` : text;
  return styles.includes("red")
    ? `<r>${inner}</r>`
    : styles.includes("green")
      ? `<g>${inner}</g>`
      : inner;
};
const brackets: DiffPaint = (styles, text) => (styles.includes("inverse") ? `[${text}]` : text);

const DIFF = [
  "--- a/src/cache.ts",
  "+++ b/src/cache.ts",
  "@@ -10,4 +10,5 @@",
  "   const sku = item.sku;",
  "-  const key = `${sku}`;",
  "+  const key = `${sku}:${currency}`;",
  "-  // old note",
  '+  if (key === undefined) throw new Error("no key");',
  "+  log(key);",
  " }",
].join("\n");

describe("word marks", () => {
  it("splits a line into words, spaces and single signs", () => {
    expect(tokens("const key = `${sku}`;")).toEqual([
      "const",
      " ",
      "key",
      " ",
      "=",
      " ",
      "`",
      "$",
      "{",
      "sku",
      "}",
      "`",
      ";",
    ]);
  });

  it("marks only the words that changed", () => {
    const d = wordDiff("const key = a;", "const key = b;");
    expect(d?.a.filter((p) => p.changed).map((p) => p.text)).toEqual(["a"]);
    expect(d?.b.filter((p) => p.changed).map((p) => p.text)).toEqual(["b"]);
  });

  it("does not mark two lines with too little in common, or very long ones", () => {
    expect(
      wordDiff("// old note", 'if (key === undefined) throw new Error("no key");'),
    ).toBeUndefined();
    const long = "x ".repeat(300);
    expect(wordDiff(long, `${long}y`)).toBeUndefined();
  });

  it("the unified diff marks the changed words of a pair; other lines keep plain colours", () => {
    const lines = unifiedDiff(DIFF, brackets).split("\n");
    expect(lines[5]).toBe("+  const key = `${sku}[:${currency}]`;");
    expect(lines[4]).toBe("-  const key = `${sku}`;");
    // The second pair has too little in common: no marks. The extra added line has no pair.
    expect(lines[6]).toBe("-  // old note");
    expect(lines[7]).toBe('+  if (key === undefined) throw new Error("no key");');
    expect(lines[8]).toBe("+  log(key);");
    const coloured = unifiedDiff(DIFF, marks).split("\n");
    expect(coloured[5]).toContain("<g>[:${currency}]</g>");
    expect(coloured[8]).toBe("<g>+  log(key);</g>");
  });
});

describe("side by side", () => {
  it("puts the old and the new line on one row, with both line numbers", () => {
    const rows = sideBySide(DIFF, 150, brackets).split("\n");
    expect(rows.slice(0, 3)).toEqual(DIFF.split("\n").slice(0, 3));
    expect(rows[3]).toMatch(
      /^ {2}10 {4}const sku = item\.sku; +│ {3}10 {4}const sku = item\.sku;$/,
    );
    expect(rows[4]).toMatch(
      /^ {2}11 - {2}const key = `\$\{sku\}`; +│ {3}11 \+ {2}const key = `\$\{sku\}\[:\$\{currency\}\]`;$/,
    );
    // The added line with no removed partner: an empty left side.
    expect(rows[6]).toMatch(/^ +│ {3}13 \+ {2}log\(key\);$/);
    expect(rows[7]).toMatch(/^ {2}13 {2}\} +│ {3}14 {2}\}$/);
    for (const row of rows) expect([...row].length).toBeLessThanOrEqual(150);
  });

  it("cuts long lines to fit, with …", () => {
    const long = ["@@ -1 +1 @@", `-${"a".repeat(200)}`, `+${"b".repeat(200)}`].join("\n");
    const rows = sideBySide(long, 140, brackets).split("\n");
    expect(rows[1]).toContain("…");
    expect([...(rows[1] ?? "")].length).toBeLessThanOrEqual(140);
  });

  it("from 140 columns the terminal gets side by side; under it, unified", () => {
    expect(terminalDiff(DIFF, SIDE_BY_SIDE_COLUMNS, brackets)).toContain("│");
    expect(terminalDiff(DIFF, SIDE_BY_SIDE_COLUMNS - 1, brackets)).not.toContain("│");
    expect(terminalDiff(DIFF, undefined, brackets)).toBe(unifiedDiff(DIFF, brackets));
  });
});

describe("text that is not a diff (the first live run)", () => {
  const consent = [
    "This project's .garuda/settings.json asks for:",
    " - permissions.allow (no question for these): bash(git status)",
    "A cloned repository can ship this file.",
  ].join("\n");

  it("keeps its simple colours at any width: no line numbers, no second column", () => {
    expect(terminalDiff(consent, 200, brackets)).toBe(consent);
    expect(terminalDiff(consent, 80, marks)).toBe(consent);
    // A whole new file (write_file) has no hunk header either: green lines, no marks.
    expect(terminalDiff("+one\n+two", 200, marks)).toBe("<g>+one</g>\n<g>+two</g>");
  });
});

describe("the approval names the hunks (UX U5)", () => {
  const request = (preview: string, hunks: boolean): ApprovalRequest => ({
    tool: "edit_file",
    target: { kind: "path", path: "src/cache.ts" },
    preview,
    isolation: "os",
    ...(hunks ? { selectHunks: () => {} } : {}),
  });
  const firstLine = (r: ApprovalRequest) => {
    const store = new ChatStore(
      { model: "m", sandbox: "s" },
      { paint: noColor, columns: () => 80 },
    );
    void store.ask(r, new AbortController().signal);
    return store.getState().items.at(-1)?.text.split("\n")[0];
  };
  const three = `${DIFF}\n@@ -30 +31 @@\n-a\n+b\n@@ -40 +41 @@\n-c\n+d`;

  it("says '3 hunks · h reviews them one by one' only when it can review them", () => {
    expect(hunkCount(three)).toBe(3);
    expect(firstLine(request(three, true))).toBe(
      "edit_file wants to change src/cache.ts: · 3 hunks · h reviews them one by one",
    );
    expect(firstLine(request(three, false))).toBe("edit_file wants to change src/cache.ts:");
    expect(firstLine(request(DIFF, true))).toBe("edit_file wants to change src/cache.ts:");
  });
});
