/**
 * Positive and negative controls for the fixes of G02, G04 and G06 (the gap tests themselves are in
 * known-agent-gaps.test.ts). Each fix must block the prohibited effect and keep the allowed
 * neighbouring operation. No network, no real home folder.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChild } from "../src/agents/child.js";
import { Runtime } from "../src/app/runtime.js";
import { KnowledgeIndex } from "../src/knowledge/index.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import type { TeamPolicy } from "../src/permissions/policy.js";
import { parseSettings } from "../src/permissions/settings.js";
import { FileSessionStore } from "../src/session/store.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { toolContext } from "./helpers.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-policy-gaps-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
function folder() {
  const root = join(base, String(n++));
  mkdirSync(root, { recursive: true });
  return root;
}
const modelId = "claude-sonnet-5";

async function runtime(root: string, policy: TeamPolicy) {
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
  });
}

type Decide = {
  networkDecision(
    hosts: readonly string[],
    host: string,
    port: number,
  ): Promise<{ allowed: boolean; reason?: string }>;
};

describe("G02: the team policy beats the project's network allowlist", () => {
  it("blocks a listed host in any spelling, and keeps the other listed hosts", async () => {
    const app = await runtime(folder(), { network: { blockedHosts: ["*.blocked.test"] } });
    try {
      const proxy = app as unknown as Decide;
      const hosts = ["api.blocked.test", "registry.npmjs.org"];
      for (const host of ["api.blocked.test", "API.Blocked.Test", "api.blocked.test."]) {
        const result = await proxy.networkDecision(hosts, host, 443);
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/blocked by team policy/);
      }
      expect((await proxy.networkDecision(hosts, "registry.npmjs.org", 443)).allowed).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("G04: files that the team policy denies stay hidden from bulk reads", () => {
  function project() {
    const root = folder();
    mkdirSync(join(root, "secret"), { recursive: true });
    writeFileSync(join(root, "secret", "private.ts"), "export const deniedMarker = 1;\n");
    writeFileSync(join(root, "public.ts"), "export const publicMarker = deniedMarker;\n");
    return root;
  }
  const policy: TeamPolicy = { denyPaths: ["secret/**"] };

  it("grep (all modes) and glob skip the denied file and still find the others", async () => {
    const root = project();
    const permissions = new PermissionEngine({
      root,
      approver: new AutoApprover("once"),
      policy,
    });
    const tools = new ToolRegistry(defaultTools());
    const run = (name: string, input: Record<string, unknown>) =>
      tools.execute(toolUse(name, input), toolContext(root, { permissions }));

    for (const mode of ["files", "content", "count"]) {
      const out = (await run("grep", { pattern: "Marker", mode })).content;
      expect(out).not.toContain("private.ts");
      expect(out).toContain("public.ts");
    }
    const listed = (await run("glob", { pattern: "**/*.ts" })).content;
    expect(listed).not.toContain("private.ts");
    expect(listed).toContain("public.ts");
    // A direct read stays denied (it was before, too).
    const read = await run("read_file", { path: "secret/private.ts" });
    expect(read.isError).toBe(true);
  });

  it("the code index does not index the denied file", async () => {
    const root = project();
    const index = new KnowledgeIndex(root, { hidden: (path) => path.startsWith("secret/") });
    expect(await index.findSymbols("deniedMarker", true)).toEqual([]);
    expect((await index.findSymbols("publicMarker", true)).map((s) => s.path)).toEqual([
      "public.ts",
    ]);
  });

  it("the runtime gives the code index the policy filter", async () => {
    const root = project();
    const app = await runtime(root, policy);
    try {
      expect(await app.knowledge.findSymbols("deniedMarker", true)).toEqual([]);
      expect(await app.knowledge.findSymbols("publicMarker", true)).not.toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("G06: a child's wrap-up request must fit in its token budget", () => {
  async function child(tokenBudget: number) {
    const root = folder();
    const model = new FakeModelClient([reply([toolUse("noop", {})]), reply([text("wrap-up")])]);
    const result = await runChild(
      {
        id: "budget",
        system: "test",
        prompt: "test",
        tools: new ToolRegistry(),
        model: { spec: modelId, contextWindow: 100_000, client: async () => model },
        permissions: toolContext(root).permissions,
        limits: { maxSteps: 1, tokenBudget },
        maxTokens: 20,
      },
      toolContext(root),
    );
    return { result, requests: model.requests.length };
  }

  it("no room: no second request, and the answer says why", async () => {
    const { result, requests } = await child(30);
    expect(requests).toBe(1);
    expect(result.answer).toMatch(/no room in its token budget/);
  });

  it("room left: the wrap-up still runs and gives the answer", async () => {
    const { result, requests } = await child(10_000);
    expect(requests).toBe(2);
    expect(result.answer).toBe("wrap-up");
  });
});
