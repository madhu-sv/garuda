import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KnowledgeIndex } from "../src/knowledge/index.js";
import { GoExpert, parseGo } from "../src/knowledge/plugins/go.js";
import { parseRust, RustExpert } from "../src/knowledge/plugins/rust.js";
import { discoverPlugins } from "../src/knowledge/plugins.js";
import { TrustStore } from "../src/mcp/trust.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "garuda-plugins-test-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("GoExpert AST parser", () => {
  it("parses Go packages, imports, structs, interfaces, functions, and methods", () => {
    const code = `package billing

import (
\t"fmt"
\t"time"
)

import "math"

type InvoiceStatus string

const (
\tStatusPending = "pending"
)

type Invoice struct {
\tID     string
\tAmount float64
}

type PaymentGateway interface {
\tProcess(inv *Invoice) error
}

func (inv *Invoice) CalculateTax(rate float64) float64 {
\treturn inv.Amount * rate
}

func CreateInvoice(id string, amount float64) *Invoice {
\treturn &Invoice{ID: id, Amount: amount}
}

func internalHelper() {
\t// unexported
}
`;

    const parsed = parseGo("billing.go", code);
    expect(parsed.imports).toEqual(["fmt", "time", "math"]);

    const pkg = parsed.symbols.find((s) => s.kind === "package");
    expect(pkg?.name).toBe("billing");

    // Types
    const invoice = parsed.symbols.find((s) => s.name === "Invoice");
    expect(invoice?.kind).toBe("struct");
    expect(invoice?.exported).toBe(true);

    const gateway = parsed.symbols.find((s) => s.name === "PaymentGateway");
    expect(gateway?.kind).toBe("interface");
    expect(gateway?.exported).toBe(true);

    const statusType = parsed.symbols.find((s) => s.name === "InvoiceStatus");
    expect(statusType?.kind).toBe("type");

    // Method with receiver container
    const taxMethod = parsed.symbols.find((s) => s.name === "CalculateTax");
    expect(taxMethod?.kind).toBe("method");
    expect(taxMethod?.container).toBe("Invoice");
    expect(taxMethod?.exported).toBe(true);

    // Function
    const createFn = parsed.symbols.find((s) => s.name === "CreateInvoice");
    expect(createFn?.kind).toBe("function");
    expect(createFn?.exported).toBe(true);

    // Unexported function
    const helperFn = parsed.symbols.find((s) => s.name === "internalHelper");
    expect(helperFn?.kind).toBe("function");
    expect(helperFn?.exported).toBe(false);

    // Exports list contains only exported symbols
    const exportNames = parsed.exports.map((e) => e.name);
    expect(exportNames).toContain("Invoice");
    expect(exportNames).toContain("PaymentGateway");
    expect(exportNames).toContain("CalculateTax");
    expect(exportNames).toContain("CreateInvoice");
    expect(exportNames).not.toContain("internalHelper");
  });

  it("finds symbols and references across Go files", () => {
    const expert = new GoExpert(root);
    const modelCode = `package store

type Item struct {
\tPrice int
}
`;
    const serviceCode = `package store

func PriceOf(i *Item) int {
\treturn i.Price
}
`;
    writeFileSync(join(root, "model.go"), modelCode);
    writeFileSync(join(root, "service.go"), serviceCode);

    const hits = expert.findSymbols(["model.go", "service.go"], "Item", true, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("model.go");
    expect(hits[0]?.kind).toBe("struct");

    const { definition, references } = expert.findReferences(
      ["model.go", "service.go"],
      "Item",
      undefined,
      50,
    );
    expect(definition?.path).toBe("model.go");
    expect(references.map((r) => r.path)).toContain("model.go");
    expect(references.map((r) => r.path)).toContain("service.go");
  });
});

describe("RustExpert AST parser", () => {
  it("parses Rust mods, uses, structs, enums, traits, functions, and impl methods", () => {
    const code = `pub mod routes;
use std::sync::Arc;
pub use std::collections::HashMap;

pub struct Config {
    pub workers: usize,
}

pub enum TaskStatus {
    Pending,
    Done,
}

pub trait Runner {
    fn run(&self);
}

impl Config {
    pub fn new(workers: usize) -> Self {
        Config { workers }
    }

    fn validate(&self) -> bool {
        self.workers > 0
    }
}

pub fn spawn_worker() {
    // top-level function
}

fn private_helper() {}

macro_rules! my_macro {
    () => {};
}
`;

    const parsed = parseRust("worker.rs", code);
    expect(parsed.imports).toEqual(["std::sync::Arc", "std::collections::HashMap"]);

    const module = parsed.symbols.find((s) => s.name === "routes");
    expect(module?.kind).toBe("module");
    expect(module?.exported).toBe(true);

    const config = parsed.symbols.find((s) => s.name === "Config");
    expect(config?.kind).toBe("struct");
    expect(config?.exported).toBe(true);

    const status = parsed.symbols.find((s) => s.name === "TaskStatus");
    expect(status?.kind).toBe("enum");

    const runner = parsed.symbols.find((s) => s.name === "Runner");
    expect(runner?.kind).toBe("trait");

    // Impl methods inside Config
    const newMethod = parsed.symbols.find((s) => s.name === "new");
    expect(newMethod?.kind).toBe("method");
    expect(newMethod?.container).toBe("Config");
    expect(newMethod?.exported).toBe(true);

    const validateMethod = parsed.symbols.find((s) => s.name === "validate");
    expect(validateMethod?.kind).toBe("method");
    expect(validateMethod?.container).toBe("Config");
    expect(validateMethod?.exported).toBe(false);

    // Free functions
    const spawnFn = parsed.symbols.find((s) => s.name === "spawn_worker");
    expect(spawnFn?.kind).toBe("function");
    expect(spawnFn?.exported).toBe(true);
    expect(spawnFn?.container).toBeUndefined();

    const helperFn = parsed.symbols.find((s) => s.name === "private_helper");
    expect(helperFn?.kind).toBe("function");
    expect(helperFn?.exported).toBe(false);

    // Macro
    const macroSym = parsed.symbols.find((s) => s.name === "my_macro");
    expect(macroSym?.kind).toBe("macro");
  });

  it("finds symbols and references across Rust files", () => {
    const expert = new RustExpert(root);
    const libCode = `pub struct OrderId(pub u64);
`;
    const mainCode = `use lib::OrderId;

fn main() {
    let id = OrderId(42);
}
`;
    writeFileSync(join(root, "lib.rs"), libCode);
    writeFileSync(join(root, "main.rs"), mainCode);

    const hits = expert.findSymbols(["lib.rs", "main.rs"], "OrderId", true, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("lib.rs");

    const { definition, references } = expert.findReferences(
      ["lib.rs", "main.rs"],
      "OrderId",
      undefined,
      50,
    );
    expect(definition?.path).toBe("lib.rs");
    expect(references.map((r) => r.path)).toContain("lib.rs");
    expect(references.map((r) => r.path)).toContain("main.rs");
  });
});

describe("Plugin discovery and security pinning", () => {
  it("includes built-in plugins by default", async () => {
    const { plugins, warnings } = await discoverPlugins({ root });
    expect(warnings).toEqual([]);
    const ids = plugins.map((p) => p.id);
    expect(ids).toContain("typescript");
    expect(ids).toContain("python");
    expect(ids).toContain("java");
    expect(ids).toContain("go");
    expect(ids).toContain("rust");
  });

  it("loads user language plugin from ~/.garuda/languages/", async () => {
    const fakeHome = join(root, "fake-home");
    const langDir = join(fakeHome, ".garuda", "languages");
    mkdirSync(langDir, { recursive: true });

    // Create a mock user plugin
    writeFileSync(
      join(langDir, "ruby.js"),
      `export default function createRubyExpert(root) {
  return {
    id: "ruby",
    extensions: [".rb"],
    summarise: (path, content) => ({ path, exports: [], imports: [] }),
    findSymbols: () => [],
    findReferences: () => ({ definition: undefined, references: [], candidates: [] })
  };
};
`,
    );

    const { plugins, warnings } = await discoverPlugins({
      root,
      home: fakeHome,
    });
    expect(warnings).toEqual([]);
    const ruby = plugins.find((p) => p.id === "ruby");
    expect(ruby).toBeDefined();
    expect(ruby?.source).toBe("user");
    expect(ruby?.extensions).toEqual([".rb"]);
  });

  it("rejects project plugin without hash approval in trust.json", async () => {
    const projDir = join(root, ".garuda", "languages");
    mkdirSync(projDir, { recursive: true });

    const pluginCode = `export default function createKotlinExpert(root) {
  return {
    id: "kotlin",
    extensions: [".kt"],
    summarise: (path, content) => ({ path, exports: [], imports: [] }),
    findSymbols: () => [],
    findReferences: () => ({ definition: undefined, references: [], candidates: [] })
  };
};
`;
    writeFileSync(join(projDir, "kotlin.js"), pluginCode);

    const fakeHome = join(root, "trust-home");
    const trust = await TrustStore.open(fakeHome);

    const { plugins, warnings } = await discoverPlugins({
      root,
      home: fakeHome,
      trust,
    });

    expect(plugins.some((p) => p.id === "kotlin")).toBe(false);
    expect(warnings.some((w) => w.includes("not approved in ~/.garuda/trust.json"))).toBe(true);

    // Now approve it in trust store and verify it loads
    const hash = createHash("sha256").update(pluginCode).digest("hex");
    await trust.setLanguageHash(root, "kotlin", hash);

    const approvedResult = await discoverPlugins({
      root,
      home: fakeHome,
      trust,
    });
    const kotlin = approvedResult.plugins.find((p) => p.id === "kotlin");
    expect(kotlin).toBeDefined();
    expect(kotlin?.source).toBe("project");
  });
});

describe("KnowledgeIndex multi-language plugins integration", () => {
  it("indexes Go and Rust alongside TS, Python, Java and reports languageStatuses", async () => {
    writeFileSync(
      join(root, "calc.go"),
      `package calc

func Add(a, b int) int {
\treturn a + b
}
`,
    );
    writeFileSync(
      join(root, "calc_test.go"),
      `package calc

import "testing"

func TestAdd(t *testing.T) {
\tif Add(1, 2) != 3 {
\t\tt.Fail()
\t}
}
`,
    );
    writeFileSync(
      join(root, "stock.rs"),
      `pub struct StockItem {
    pub sku: String,
}
`,
    );

    const index = new KnowledgeIndex(root);

    // Check language statuses
    const statuses = await index.languageStatuses();
    const goStatus = statuses.find((s) => s.id === "go");
    expect(goStatus).toBeDefined();
    expect(goStatus?.active).toBe(true);
    expect(goStatus?.indexedFiles).toBeGreaterThanOrEqual(2);

    const rustStatus = statuses.find((s) => s.id === "rust");
    expect(rustStatus).toBeDefined();
    expect(rustStatus?.active).toBe(true);
    expect(rustStatus?.indexedFiles).toBeGreaterThanOrEqual(1);

    // Cross-language findSymbols
    const goHits = await index.findSymbols("Add", true);
    expect(goHits.some((h) => h.path === "calc.go")).toBe(true);

    const rustHits = await index.findSymbols("StockItem", true);
    expect(rustHits.some((h) => h.path === "stock.rs")).toBe(true);

    // Impact analysis test discovery for Go
    const impact = await index.impactAnalysis("calc.go");
    expect(impact.affectedTests).toContain("calc_test.go");

    // AST query on Go and Rust
    const structs = await index.astQuery({ kind: "struct" });
    expect(structs.some((s) => s.name === "StockItem")).toBe(true);
  });

  it("indexes external polyglot repository with all 5 languages", async () => {
    const polyglotRoot = "/Users/madhusudhan/dev/garuda-polyglot";
    const { existsSync } = await import("node:fs");
    if (!existsSync(polyglotRoot)) return;

    const index = new KnowledgeIndex(polyglotRoot);
    const statuses = await index.languageStatuses();
    const activeLanguages = statuses.filter((s) => s.active).map((s) => s.id);

    expect(activeLanguages).toContain("typescript");
    expect(activeLanguages).toContain("python");
    expect(activeLanguages).toContain("java");
    expect(activeLanguages).toContain("go");
    expect(activeLanguages).toContain("rust");

    const goHit = await index.findSymbols("TaxCalculator", true);
    expect(goHit.length).toBeGreaterThanOrEqual(1);

    const rustHit = await index.findSymbols("StockItem", true);
    expect(rustHit.length).toBeGreaterThanOrEqual(1);

    const impact = await index.impactAnalysis("src/billing/calc.go");
    expect(impact.affectedTests).toContain("src/billing/calc_test.go");
  });
});
