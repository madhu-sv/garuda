/**
 * M0 desired-behaviour reproductions. it.fails asserts the intended contract, NOT the bug.
 * Expected failures remain open issues, never safety passes. When a fix makes one pass,
 * Vitest fails this suite until it.fails is promoted to it. No live API or network requests.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runChild } from "../src/agents/child.js";
import { createMoeDispatchTool } from "../src/agents/moe.js";
import { Runtime } from "../src/app/runtime.js";
import { AuditLogger } from "../src/audit/logger.js";
import { KnowledgeIndex } from "../src/knowledge/index.js";
import { discoverPlugins } from "../src/knowledge/plugins.js";
import { runTools } from "../src/loop/toolRunner.js";
import { TrustStore } from "../src/mcp/trust.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { parseSettings } from "../src/permissions/settings.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { Redactor } from "../src/session/redact.js";
import { FileSessionStore } from "../src/session/store.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";
import { toolContext } from "./helpers.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-known-agent-gaps-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let sequence = 0;
function folder() {
  const root = join(base, String(sequence++));
  mkdirSync(root, { recursive: true });
  return root;
}
const signal = new AbortController().signal;
const modelId = "claude-sonnet-5";
/** The intended assertion text of each open gap (docs/quality-baseline/known-gap-contracts.json). */
const contracts = z
  .object({ failurePatterns: z.record(z.string(), z.string()) })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../docs/quality-baseline/known-gap-contracts.json", import.meta.url),
        "utf8",
      ),
    ),
  );

/**
 * An open gap. In strict mode it is an ordinary test (it fails). Otherwise it is `it.fails`, but
 * only the INTENDED assertion counts as the expected failure: any other error (a TypeError after a
 * rename, a setup failure, a different assertion) is swallowed, so the body "passes" and `it.fails`
 * reports it. Before this, `it.fails` passed on any thrown error and hid real regressions.
 */
function knownGap(name: string, body: () => Promise<void>): void {
  if (process.env.GARUDA_GAP_REPRO_STRICT === "1") {
    it(name, body);
    return;
  }
  const pattern = contracts.failurePatterns[name];
  if (pattern === undefined) throw new Error(`No failure pattern for "${name}"`);
  it.fails(name, async () => {
    try {
      await body();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAssertion = error instanceof Error && error.name === "AssertionError";
      if (isAssertion && message.includes(pattern)) throw error;
      // Not the intended failure: let `it.fails` report this test.
      return;
    }
  });
}
async function runtime(
  root: string,
  policy: NonNullable<Parameters<typeof Runtime.create>[0]["policy"]>,
) {
  return Runtime.create({
    root,
    modelId,
    model: new FakeModelClient([]),
    policy,
    settings: parseSettings({ executor: "host", undo: { enabled: false } }),
    approver: new AutoApprover("once"),
    store: new FileSessionStore(root),
    mcp: false,
    hooks: false,
    commands: false,
    profiles: [],
    models: {
      resolve: (spec) => ({
        spec,
        model: async () => new FakeModelClient([]),
        info: { contextWindow: 100_000 },
      }),
    },
  });
}

describe("Known agent gaps: policy, execution, audit, indexing and plugin trust", () => {
  it("G01 model switching must reject a model forbidden by team policy", async () => {
    const app = await runtime(folder(), { allowedModels: [modelId] });
    try {
      const result = await app.setModel("forbidden/model");
      expect(result.ok).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("G02 proxy allowlist must not override a team blocked host", async () => {
    const app = await runtime(folder(), { network: { blockedHosts: ["blocked.test"] } });
    try {
      // Component seam: no socket, DNS or HTTP effect. Full proxy route remains a follow-up.
      const proxy = app as unknown as {
        networkDecision(
          hosts: readonly string[],
          host: string,
          port: number,
        ): Promise<{ allowed: boolean }>;
      };
      const result = await proxy.networkDecision(["blocked.test"], "blocked.test", 443);
      expect(result.allowed).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("G03 requireSandbox must reject a command on an executor with no isolation", async () => {
    const permissions = new PermissionEngine({
      root: folder(),
      approver: new AutoApprover("once"),
      isolation: "none",
      policy: { requireSandbox: true },
    });
    const result = await permissions.check(
      {
        tool: "bash",
        readOnly: false,
        info: { target: { kind: "command", command: "echo harmless" } },
      },
      signal,
    );
    expect(result.allowed).toBe(false);
  });

  it("G04 grep must not expose a policy-denied ordinary source file", async () => {
    const root = folder();
    writeFileSync(join(root, "private.ts"), "export const deniedMarker = 1;\n");
    const permissions = new PermissionEngine({
      root,
      approver: new AutoApprover("once"),
      policy: { denyPaths: ["private.ts"] },
    });
    const tools = new ToolRegistry(defaultTools());
    const outcome = await tools.execute(
      toolUse("grep", { pattern: "deniedMarker", mode: "content" }),
      toolContext(root, { permissions }),
    );
    expect(outcome.content).not.toContain("deniedMarker");
  });

  it("G05 writable specialist children must not execute mutations concurrently", async () => {
    const root = folder();
    let active = 0;
    let peak = 0;
    let completed = 0;
    const write: Tool<{ path: string; content: string }> = {
      name: "write_file",
      description: "Controlled mutation probe",
      readOnly: false,
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      async run({ path, content }) {
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          writeFileSync(join(root, path), content);
          completed++;
          return "written";
        } finally {
          active--;
        }
      },
    };
    const tools = new ToolRegistry([write]);
    let children = 0;
    const permissions = toolContext(root).permissions;
    tools.register(
      createMoeDispatchTool({
        mainTools: () => tools,
        permissions,
        executor: new HostExecutor(),
        model: async () => {
          const id = children++;
          return {
            spec: modelId,
            contextWindow: 100_000,
            client: async () =>
              new FakeModelClient([
                reply([toolUse("write_file", { path: `${id}.txt`, content: "safe fixture" })]),
                reply([text("done")]),
              ]),
          };
        },
      }),
    );
    await runTools(
      [0, 1].map((id) =>
        toolUse(
          "delegate_expert",
          { language: "go", task: "Write the isolated probe fixture" },
          `child-${id}`,
        ),
      ),
      { tools },
      toolContext(root, { permissions }),
      () => {},
    );
    expect(completed).toBe(2);
    expect(peak).toBe(1);
  });

  it("G06 child budget exhaustion must not start an unreserved wrap-up request", async () => {
    const root = folder();
    const model = new FakeModelClient([reply([toolUse("noop", {})]), reply([text("wrap-up")])]);
    // max_steps forces synthesis after the first request has already exceeded tokenBudget.
    await runChild(
      {
        id: "budget",
        system: "test",
        prompt: "test",
        tools: new ToolRegistry(),
        model: { spec: modelId, contextWindow: 100_000, client: async () => model },
        permissions: toolContext(root).permissions,
        limits: { maxSteps: 1, tokenBudget: 1 },
        maxTokens: 20,
      },
      toolContext(root),
    );
    expect(model.requests.length).toBeLessThanOrEqual(1);
  });

  it("G07 audit targets must redact synthetic token assignments", async () => {
    const root = folder();
    const command = "echo token=m0_canary_secret_123456";
    expect(new Redactor({}).text(command)).not.toContain("m0_canary_secret_123456");
    const audit = new AuditLogger(root, { env: {} });
    await audit.logToolExecution({
      tool: "bash",
      target: { kind: "command", command },
      durationMs: 1,
      isError: false,
    });
    expect(readFileSync(audit.filePath, "utf8")).not.toContain("m0_canary_secret_123456");
  });

  it("G07 mandatory audit persistence must surface a write failure", async () => {
    const root = folder();
    writeFileSync(join(root, ".garuda"), "not a directory");
    // Mandatory = the team policy turns the audit log on explicitly.
    await expect(
      new AuditLogger(join(root, ".garuda", "audit"), {
        policy: { audit: { enabled: true } },
      }).logToolExecution({ tool: "probe", durationMs: 1, isError: false }),
    ).rejects.toThrow();
  });

  knownGap(
    "G07 child execution must persist an outcome in addition to its permission decision",
    async () => {
      const root = folder();
      writeFileSync(join(root, "data.txt"), "fixture");
      const audit = new AuditLogger(root);
      const permissions = new PermissionEngine({
        root,
        approver: new AutoApprover("once"),
        auditLogger: audit,
      });
      const model = new FakeModelClient([
        reply([toolUse("read_file", { path: "data.txt" })]),
        reply([text("done")]),
      ]);
      await runChild(
        {
          id: "audit",
          system: "test",
          prompt: "read",
          tools: new ToolRegistry(defaultTools()),
          model: { spec: modelId, contextWindow: 100_000, client: async () => model },
          permissions,
          limits: { maxSteps: 3, tokenBudget: 1000 },
          maxTokens: 20,
        },
        toolContext(root, { permissions, audit }),
      );
      const events = await audit.readEvents();
      expect(events.some((event) => event.decision === "allow_readonly")).toBe(true);
      expect(events.some((event) => event.decision === "executed")).toBe(true);
    },
  );

  it("G08 a module-level Python reference must not be attributed to the preceding function", async () => {
    const root = folder();
    writeFileSync(
      join(root, "calls.py"),
      "def target():\n    pass\n\ndef helper():\n    target()\n\ntarget()\n",
    );
    const result = await new KnowledgeIndex(root, { home: folder() }).findCallers("target");
    expect(result.callers.find((caller) => caller.callLine === 7)?.callerName).toBe("<module>");
  });

  it("G08 an unresolved impact target must not be labelled low risk", async () => {
    const root = folder();
    writeFileSync(join(root, "a.py"), "def known():\n    pass\n");
    const result = await new KnowledgeIndex(root, { home: folder() }).impactAnalysis(
      "missingSymbol",
    );
    expect(result.riskLevel).not.toBe("low");
  });

  knownGap("G09 entry-file approval must not trust a changed imported dependency", async () => {
    const root = folder();
    const home = folder();
    const plugins = join(root, ".garuda", "languages");
    mkdirSync(plugins, { recursive: true });
    const code =
      'import { id } from "./dependency.cjs";\nexport default { id, extensions: [".probe"], factory: () => ({}) };\n';
    writeFileSync(join(plugins, "probe.mjs"), code);
    writeFileSync(join(plugins, "dependency.cjs"), 'exports.id = "original";\n');
    const trust = await TrustStore.open(home);
    await trust.setLanguageHash(root, "probe", createHash("sha256").update(code).digest("hex"));
    writeFileSync(join(plugins, "dependency.cjs"), 'exports.id = "changed";\n');
    // Project plugins are off by default (merge gate); the gap is in the opt-in path.
    const result = await discoverPlugins({
      root,
      home,
      trust,
      includeBuiltins: false,
      projectPlugins: true,
    });
    expect(result.plugins.some((plugin) => plugin.id === "changed")).toBe(false);
  });
});
