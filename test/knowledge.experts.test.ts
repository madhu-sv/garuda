import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KnowledgeIndex } from "../src/knowledge/index.js";
import { JavaExpert, parseJava } from "../src/knowledge/java.js";
import { PythonExpert, parsePython } from "../src/knowledge/python.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "garuda-experts-test-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("PythonExpert AST parser", () => {
  it("parses Python exports, imports, functions, classes, and methods", () => {
    const code = `
import os, sys
from typing import List, Optional
from .helper import helper_fn

API_KEY = "xyz"
_PRIVATE_CONST = 123

class OrderService:
    def __init__(self, repo):
        self.repo = repo

    def calculate_total(self, items: List[int]) -> int:
        return sum(items)

async def fetch_order(order_id: str):
    pass

def _internal_helper():
    pass
`;

    const parsed = parsePython("order.py", code);
    expect(parsed.imports).toEqual(["os", "sys", "typing", ".helper"]);
    expect(parsed.exports.map((e) => e.name)).toEqual(["API_KEY", "OrderService", "fetch_order"]);

    const symbols = parsed.symbols;
    expect(symbols.find((s) => s.name === "OrderService")?.kind).toBe("class");
    expect(symbols.find((s) => s.name === "calculate_total")?.kind).toBe("method");
    expect(symbols.find((s) => s.name === "calculate_total")?.container).toBe("OrderService");
    expect(symbols.find((s) => s.name === "fetch_order")?.kind).toBe("function");
    expect(symbols.find((s) => s.name === "_internal_helper")?.exported).toBe(false);
  });

  it("respects __all__ export list in Python", () => {
    const code = `
__all__ = ["exported_fn"]

def exported_fn():
    pass

def not_exported_fn():
    pass
`;
    const parsed = parsePython("mod.py", code);
    expect(parsed.symbols.find((s) => s.name === "exported_fn")?.exported).toBe(true);
    expect(parsed.symbols.find((s) => s.name === "not_exported_fn")?.exported).toBe(false);
  });

  it("finds symbols and references across Python files", async () => {
    const pyExpert = new PythonExpert(root);
    const serviceCode = `
from models import Product

def create_order(product_id: str):
    prod = Product(product_id)
    return prod.get_price()
`;
    const modelsCode = `
class Product:
    def __init__(self, pid: str):
        self.pid = pid

    def get_price(self):
        return 100
`;
    writeFileSync(join(root, "service.py"), serviceCode);
    writeFileSync(join(root, "models.py"), modelsCode);

    const hits = pyExpert.findSymbols(["service.py", "models.py"], "Product", true, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.name).toBe("Product");
    expect(hits[0]?.path).toBe("models.py");
    expect(hits[0]?.kind).toBe("class");

    const { definition, references } = pyExpert.findReferences(
      ["service.py", "models.py"],
      "Product",
      undefined,
      50,
    );
    expect(definition?.path).toBe("models.py");
    expect(definition?.line).toBe(2);
    expect(references.map((r) => r.path)).toContain("service.py");
    expect(references.map((r) => r.path)).toContain("models.py");
    expect(references.find((r) => r.isDefinition)?.path).toBe("models.py");
  });
});

describe("JavaExpert AST parser", () => {
  it("parses Java packages, imports, classes, records, and methods", () => {
    const code = `
package com.garuda.service;

import java.util.List;
import com.garuda.model.Order;
import static com.garuda.util.Money.format;

public class OrderProcessor {
    private final String id;

    public OrderProcessor(String id) {
        this.id = id;
    }

    public double calculateDiscount(Order order) {
        return order.amount() * 0.1;
    }
}

record OrderRecord(String id, double amount) {}
interface OrderHandler {}
enum OrderStatus { PENDING, COMPLETED }
`;

    const parsed = parseJava("OrderProcessor.java", code);
    expect(parsed.imports).toEqual([
      "java.util.List",
      "com.garuda.model.Order",
      "com.garuda.util.Money.format",
    ]);

    const names = parsed.symbols.map((s) => s.name);
    expect(names).toContain("OrderProcessor");
    expect(names).toContain("calculateDiscount");
    expect(names).toContain("OrderRecord");
    expect(names).toContain("OrderHandler");
    expect(names).toContain("OrderStatus");

    const discountMethod = parsed.symbols.find((s) => s.name === "calculateDiscount");
    expect(discountMethod?.kind).toBe("method");
    expect(discountMethod?.container).toBe("OrderProcessor");
    expect(discountMethod?.exported).toBe(true);
  });

  it("finds symbols and references across Java files", async () => {
    const javaExpert = new JavaExpert(root);
    const serviceCode = `
package com.garuda;

public class App {
    public static void main(String[] args) {
        User user = new User("alice");
        user.print();
    }
}
`;
    const userCode = `
package com.garuda;

public class User {
    private String name;
    public User(String name) { this.name = name; }
    public void print() { System.out.println(name); }
}
`;
    writeFileSync(join(root, "App.java"), serviceCode);
    writeFileSync(join(root, "User.java"), userCode);

    const symbols = javaExpert.findSymbols(["App.java", "User.java"], "User", true, 10);
    expect(symbols.some((s) => s.name === "User" && s.path === "User.java")).toBe(true);

    const { definition, references } = javaExpert.findReferences(
      ["App.java", "User.java"],
      "User",
      undefined,
      50,
    );
    expect(definition?.path).toBe("User.java");
    expect(references.map((r) => r.path)).toContain("App.java");
    expect(references.map((r) => r.path)).toContain("User.java");
  });
});

describe("Multi-language KnowledgeIndex integration", () => {
  it("indexes and searches across TS, Python, and Java simultaneously", async () => {
    writeFileSync(join(root, "calc.ts"), "export function calculateTotal() { return 42; }\n");
    writeFileSync(join(root, "billing.py"), "def calculate_billing():\n    return 42\n");
    writeFileSync(
      join(root, "Payment.java"),
      "public class PaymentService { public void pay() {} }\n",
    );

    const index = new KnowledgeIndex(root);

    // Search across all languages
    const tsHits = await index.findSymbols("calculateTotal", true);
    expect(tsHits.map((h) => h.path)).toContain("calc.ts");

    const pyHits = await index.findSymbols("calculate_billing", true);
    expect(pyHits.map((h) => h.path)).toContain("billing.py");

    const javaHits = await index.findSymbols("PaymentService", true);
    expect(javaHits.map((h) => h.path)).toContain("Payment.java");

    // Unified repoMap
    const map = await index.repoMap();
    const paths = map.map((n) => n.path);
    expect(paths).toContain("calc.ts");
    expect(paths).toContain("billing.py");
    expect(paths).toContain("Payment.java");
  });

  it("finds callers across languages and resolves enclosing caller scope", async () => {
    writeFileSync(
      join(root, "engine.py"),
      `
def compute_metrics(x):
    return x * 2

def run_pipeline():
    result = compute_metrics(10)
    return result
`,
    );

    writeFileSync(
      join(root, "AppController.java"),
      `
package com.garuda;

public class AppController {
    public void start() {
        processOrder();
    }

    public void processOrder() {
        System.out.println("processing");
    }
}
`,
    );

    const index = new KnowledgeIndex(root);

    // Python callers
    const pyCallers = await index.findCallers("compute_metrics");
    expect(pyCallers.definition?.name).toBe("compute_metrics");
    expect(pyCallers.callers.length).toBeGreaterThanOrEqual(1);
    expect(pyCallers.callers[0]?.callerName).toBe("run_pipeline");
    expect(pyCallers.callers[0]?.path).toBe("engine.py");

    // Java callers
    const javaCallers = await index.findCallers("processOrder");
    expect(javaCallers.definition?.name).toBe("processOrder");
    expect(javaCallers.callers.length).toBeGreaterThanOrEqual(1);
    expect(javaCallers.callers[0]?.callerName).toBe("AppController.start");
    expect(javaCallers.callers[0]?.path).toBe("AppController.java");
  });

  it("performs impact analysis with blast radius and test discovery", async () => {
    writeFileSync(
      join(root, "core_auth.py"),
      `
def authenticate(token):
    return True
`,
    );

    writeFileSync(
      join(root, "api_routes.py"),
      `
from core_auth import authenticate

def login():
    return authenticate("xyz")
`,
    );

    writeFileSync(
      join(root, "test_core_auth.py"),
      `
from core_auth import authenticate

def test_auth():
    assert authenticate("abc") == True
`,
    );

    const index = new KnowledgeIndex(root);

    // Impact of symbol authenticate
    const symImpact = await index.impactAnalysis("authenticate");
    expect(symImpact.targetKind).toBe("symbol");
    expect(symImpact.definitions.length).toBeGreaterThanOrEqual(1);
    expect(symImpact.dependentFiles).toContain("api_routes.py");
    expect(symImpact.callers.some((c) => c.callerName === "login")).toBe(true);
    expect(symImpact.affectedTests).toContain("test_core_auth.py");
    expect(symImpact.summary).toContain("blast radius");

    // Impact of file core_auth.py
    const fileImpact = await index.impactAnalysis("core_auth.py");
    expect(fileImpact.targetKind).toBe("file");
    expect(fileImpact.resolvedPath).toBe("core_auth.py");
    expect(fileImpact.dependentFiles).toContain("api_routes.py");
    expect(fileImpact.affectedTests).toContain("test_core_auth.py");
  });

  it("executes structural astQuery across all languages", async () => {
    const index = new KnowledgeIndex(root);

    // Filter by kind
    const classes = await index.astQuery({ kind: "class" });
    const classNames = classes.map((c) => c.name);
    expect(classNames).toContain("AppController");

    // Filter by container
    const appMethods = await index.astQuery({
      container: "AppController",
      kind: "method",
    });
    expect(appMethods.map((m) => m.name)).toContain("processOrder");
    expect(appMethods.map((m) => m.name)).toContain("start");

    // Filter by pattern
    const authSymbols = await index.astQuery({ namePattern: "*auth*" });
    expect(authSymbols.some((s) => s.name === "authenticate")).toBe(true);
  });
});
