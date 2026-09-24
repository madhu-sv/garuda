import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFiles } from "../src/evals/runner.js";
import { shopkit } from "../src/evals/shopkit.js";
import { GRAPH_FILE, KnowledgeIndex } from "../src/knowledge/index.js";
import type { ToolUseBlock } from "../src/model/types.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { toolContext } from "./helpers.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "garuda-index-")));
const index = new KnowledgeIndex(root);
beforeAll(async () => {
  await writeFiles(root, {
    ...shopkit(),
    ".env": "export const SECRET = 1;\n",
    "node_modules/x/index.js": "export function formatPrice() {}\n",
    ".gitignore": "node_modules/\n",
  });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("code index: TypeScript/JavaScript expert", () => {
  it("finds a definition by exact name", async () => {
    const hits = await index.findSymbols("formatPrice", true);
    expect(hits).toEqual([
      { name: "formatPrice", kind: "function", path: "src/core/money.js", line: 6, exported: true },
    ]);
  }, 30_000);

  it("finds every reference across files, following imports, and nothing in ignored folders", async () => {
    const { definition, references } = await index.findReferences("formatPrice");
    expect(definition?.path).toBe("src/core/money.js");
    const files = [...new Set(references.map((r) => r.path))];
    expect(files).toEqual([
      "src/core/money.js",
      "src/domains/discount/service.js",
      "src/domains/invoice/service.js",
      "src/domains/order/service.js",
      "src/domains/payment/service.js",
      "src/domains/product/service.js",
      "src/domains/refund/service.js",
      "test/core/money.test.js",
    ]);
    expect(references.filter((r) => r.isDefinition)).toHaveLength(1);
  });

  it("shows unused code: a function with only its definition", async () => {
    const used = await index.findReferences("toIsoDate");
    const unused = await index.findReferences("isWeekend");
    expect(used.references.length).toBeGreaterThan(1);
    expect(unused.references.map((r) => r.path)).toEqual(["src/core/dates.js"]);
  });

  it("reports other definitions with the same name, and lets the caller choose a file", async () => {
    const any = await index.findReferences("create");
    expect(any.candidates.length).toBeGreaterThan(10);
    const chosen = await index.findReferences("create", "src/domains/coupon/service.js");
    expect(chosen.definition?.path).toBe("src/domains/coupon/service.js");
  });

  it("sees a change to a file at the next query", async () => {
    writeFileSync(
      join(root, "src/core/extra.js"),
      'import { formatPrice } from "./money.js";\nexport const x = formatPrice(1);\n',
    );
    const { references } = await index.findReferences("formatPrice");
    expect(references.some((r) => r.path === "src/core/extra.js")).toBe(true);
    rmSync(join(root, "src/core/extra.js"));
  });

  it("builds the code graph (exports and imports per file), caches it, and skips sensitive files", async () => {
    const nodes = await index.repoMap("src/core");
    expect(nodes.map((n) => n.path)).toContain("src/core/money.js");
    expect(nodes.find((n) => n.path === "src/core/money.js")?.exports.map((e) => e.name)).toEqual([
      "toCents",
      "formatPrice",
    ]);
    const order = (await index.repoMap("src/domains/order")).find((n) =>
      n.path.endsWith("service.js"),
    );
    expect(order?.imports).toContain("../../core/money.js");
    expect(existsSync(join(root, GRAPH_FILE))).toBe(true);
    const graph = JSON.parse(readFileSync(join(root, GRAPH_FILE), "utf8"));
    expect(Object.keys(graph.files)).not.toContain(".env");
    expect(Object.keys(graph.files).some((p) => p.startsWith("node_modules/"))).toBe(false);
  });
});

describe("code tools", () => {
  const registry = new ToolRegistry(defaultTools());
  const call = (name: string, input: unknown) => {
    const block: ToolUseBlock = { type: "tool_use", id: "c", name, input };
    return registry.execute(block, toolContext(root, { knowledge: index }));
  };

  it("find_symbol, find_references and repo_map give short text for the model", async () => {
    expect((await call("find_symbol", { name: "OrderService", exact: true })).content).toBe(
      "src/domains/order/service.js:7  class OrderService (exported)",
    );
    const refs = (await call("find_references", { name: "formatPrice" })).content;
    expect(refs).toMatch(
      /^formatPrice is defined at src\/core\/money\.js:6 \(function\)\. 16 reference\(s\) in 8 file\(s\):/,
    );
    expect(refs).toContain(
      'src/domains/invoice/service.js:3  import { formatPrice } from "../../core/money.js";',
    );
    expect((await call("repo_map", { path: "src/core" })).content).toContain(
      "src/core/money.js: toCents (function), formatPrice (function)",
    );
    // The whole repo (over 30 files): one line per folder, small enough to keep in context.
    const whole = (await call("repo_map", {})).content;
    expect(whole).toMatch(/^\d+ files in \d+ folders\. Call repo_map with a folder/);
    expect(whole).toContain(
      "src/domains/order/ (3 files): createOrder, OrderRepository, OrderService",
    );
    expect(whole.length).toBeLessThan(4_000);
  });

  it("fails clearly with no index", async () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      id: "c",
      name: "find_symbol",
      input: { name: "x" },
    };
    const r = await registry.execute(block, toolContext(root));
    expect(r.content).toMatch(/no code index/);
  });
});
