import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildSpecialistSystem,
  createMoeDispatchTool,
  DELEGATE_EXPERT_TOOL,
  inferLanguage,
  SPECIALIST_SPECS,
} from "../src/agents/moe.js";
import { Runtime } from "../src/app/runtime.js";
import { runCommand } from "../src/cli/chat/commands.js";
import { PlainRenderer } from "../src/cli/renderer.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { FileSessionStore } from "../src/session/store.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { allowAll, sink, toolContext } from "./helpers.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-moe-test-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("MoE Language Inference & Specialist Prompts", () => {
  it("infers language from file extensions and keywords", () => {
    expect(inferLanguage("refactor this logic", ["src/calc.go"])).toBe("go");
    expect(inferLanguage("optimize memory", ["src/stock.rs"])).toBe("rust");
    expect(inferLanguage("fix tests", ["tests/test_api.py"])).toBe("python");
    expect(inferLanguage("add service", ["src/Payment.java"])).toBe("java");
    expect(inferLanguage("update component", ["src/App.tsx"])).toBe("typescript");

    // Keywords
    expect(inferLanguage("check cargo dependencies and lifetime bounds")).toBe("rust");
    expect(inferLanguage("fix the goroutine leak and channels")).toBe("go");
    expect(inferLanguage("run pytest on the new fixtures")).toBe("python");
    expect(inferLanguage("update pom.xml and spring configuration")).toBe("java");
    expect(inferLanguage("add vitest test case")).toBe("typescript");
  });

  it("builds specialist system prompt with language rules and profile notes", () => {
    const prompt = buildSpecialistSystem(SPECIALIST_SPECS.go, "/my/project", [
      {
        id: "python",
        label: "Go Module",
        test: "go test ./...",
        notes: ["Use go test -v ./..."],
        access: { writePaths: [], envAllow: [] },
      },
    ]);
    expect(prompt).toContain("Go Language Specialist");
    expect(prompt).toContain("Structs, interfaces, and receiver methods");
    expect(prompt).toContain("Working root: /my/project");
    expect(prompt).toContain("Detected Project Language Profile: Go Module");
    expect(prompt).toContain("Use go test -v ./...");
  });
});

describe("MoE delegate_expert tool execution", () => {
  it("spawns a language specialist subagent and returns synthesized report", async () => {
    const root = join(base, "proj1");
    const childModel = new FakeModelClient([
      reply([toolUse("read_file", { path: "calc.go" })]),
      reply([text("Tax calculation in calc.go uses 10% rate properly. All tests pass.")]),
    ]);

    const registry = new ToolRegistry(defaultTools({ codeIndex: "lookup" }));
    const tool = createMoeDispatchTool({
      mainTools: () => registry,
      model: async () => ({
        spec: "test-model",
        client: async () => childModel,
        contextWindow: 100_000,
      }),
      permissions: allowAll(root),
      executor: new HostExecutor(),
    });

    expect(tool.name).toBe(DELEGATE_EXPERT_TOOL);

    const context = toolContext(root);
    const result = await tool.run(
      {
        language: "go",
        task: "Verify tax calculation in calc.go",
        files: ["calc.go"],
      },
      context,
    );

    expect(result.language).toBe("go");
    expect(result.specialist).toBe("Go Specialist");
    expect(result.answer).toContain("Tax calculation in calc.go uses 10% rate");
    expect(result.calls.some((c) => c.includes("read_file calc.go"))).toBe(true);

    const rendered = tool.toText?.(result);
    expect(rendered).toContain("[Go Specialist Report]");
    expect(rendered).toContain("moe-expert go: 2 steps");
  });
});

describe("MoE Runtime and /experts command integration", () => {
  it("registers delegate_expert in Runtime when moe/subagents is enabled", async () => {
    const root = join(base, "proj2");
    writeFileSync(join(base, "calc.go"), "package main\n");

    const runtime = await Runtime.create({
      root,
      modelId: "claude-sonnet-5",
      model: async () => new FakeModelClient([]),
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({
        executor: "host",
        subagents: { enabled: true },
        moe: { enabled: true },
      }),
      mcp: false,
      hooks: false,
      profiles: [],
    });

    const { stream, text: getText } = sink();
    const renderer = new PlainRenderer({ out: stream, err: stream });

    expect(
      await runCommand("/experts", {
        runtime,
        renderer,
        sessionPath: () => "",
      }),
    ).toBe("done");

    const output = getText();
    expect(output).toContain("Mixture-of-Experts (MoE) Language Specialists:");
    expect(output).toContain("Go Specialist (go):");
    expect(output).toContain("Rust Specialist (rust):");
    expect(output).toContain("Python Specialist (python):");
    expect(output).toContain("Java Specialist (java):");
    expect(output).toContain("TypeScript/JavaScript Specialist (typescript):");
  });
});
