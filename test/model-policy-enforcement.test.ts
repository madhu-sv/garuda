import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Runtime, type RuntimeOptions } from "../src/app/runtime.js";
import { runCommand } from "../src/cli/chat/commands.js";
import { noColor } from "../src/cli/chat/markdown.js";
import { ChatStore } from "../src/cli/chat/store.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { loadTeamPolicy } from "../src/permissions/policy.js";
import { parseSettings } from "../src/permissions/settings.js";
import { FileSessionStore } from "../src/session/store.js";

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "garuda-model-policy-")));
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));
let sequence = 0;
const mainModelId = "fake-main";
const modelInfo = { contextWindow: 100_000 };
const signal = () => new AbortController().signal;
function project() {
  const root = join(fixtureRoot, String(sequence++));
  mkdirSync(root, { recursive: true });
  return root;
}
async function createRuntime(root: string, extra: Partial<RuntimeOptions> = {}) {
  return Runtime.create({
    root,
    modelId: mainModelId,
    model: new FakeModelClient([]),
    modelInfo,
    policy: { allowedModels: [mainModelId] },
    settings: parseSettings({ executor: "host", undo: { enabled: false } }),
    approver: new AutoApprover("once"),
    store: new FileSessionStore(root),
    mcp: false,
    hooks: false,
    commands: false,
    profiles: [],
    ...extra,
  });
}
function choices(resolvedId?: string) {
  const client = new FakeModelClient([reply([text("Allowed model answer.")])]);
  const factory = vi.fn(async () => client);
  const resolve = vi.fn((spec: string) => ({
    spec: resolvedId ?? spec,
    model: factory,
    info: modelInfo,
  }));
  return { client, factory, resolve, configured: ["local/allowed"] };
}

describe("G01 model policy enforcement", () => {
  it("rejects a forbidden startup model without constructing its provider", async () => {
    const provider = vi.fn(async () => new FakeModelClient([]));
    await expect(
      createRuntime(project(), { modelId: "forbidden/model", model: provider }),
    ).rejects.toThrow('Model "forbidden/model" is not permitted by team policy');
    expect(provider).not.toHaveBeenCalled();
  });

  it.each(["claude-sonnet-5", "sonnet", "list-number"])(
    "rejects /models %s without changing the session or constructing a provider",
    async (ref) => {
      const root = project();
      const provider = choices();
      const app = await createRuntime(root, {
        model: new FakeModelClient([reply([text("Original answer.")])]),
        models: provider,
      });
      try {
        await app.runTurn("Keep this conversation.", signal());
        const session = app.session;
        const messages = structuredClone(session?.messages);
        const limits = { ...app.limits };
        const journal = new FileSessionStore(root);
        const before = await journal.read(session?.id as string);
        const selected =
          ref === "list-number"
            ? String(app.modelList().findIndex((m) => m.spec === "claude-sonnet-5") + 1)
            : ref;
        const renderer = new ChatStore({ model: mainModelId, sandbox: "none" }, { paint: noColor });
        await runCommand(`/models ${selected}`, {
          runtime: app,
          renderer,
          sessionPath: (id) => id,
        });
        expect(renderer.getState().items.at(-1)?.text).toContain("not permitted by team policy");
        expect(provider.factory).not.toHaveBeenCalled();
        expect(app.modelId).toBe(mainModelId);
        expect(app.limits).toEqual(limits);
        expect(app.session).toBe(session);
        expect(app.session?.messages).toEqual(messages);
        expect(await journal.read(session?.id as string)).toEqual(before);
      } finally {
        await app.close();
      }
    },
  );

  it("checks a resolver's final model ID before provider construction", async () => {
    const provider = choices("forbidden/model");
    const app = await createRuntime(project(), {
      policy: { allowedModels: [mainModelId, "local/*"] },
      models: provider,
    });
    try {
      expect(await app.setModel("local/allowed")).toMatchObject({ ok: false });
      expect(provider.resolve).toHaveBeenCalledWith("local/allowed");
      expect(provider.factory).not.toHaveBeenCalled();
      expect(app.modelId).toBe(mainModelId);
    } finally {
      await app.close();
    }
  });

  it("enforces the team policy loaded from ~/.garuda during switching", async () => {
    const root = project();
    const home = project();
    mkdirSync(join(home, ".garuda"), { recursive: true });
    writeFileSync(
      join(home, ".garuda", "policy.json"),
      JSON.stringify({ allowedModels: [mainModelId] }),
    );
    const team = await loadTeamPolicy({ home, managed: undefined });
    if (team === undefined) throw new Error("no policy");
    const provider = choices();
    const app = await Runtime.create({
      root,
      modelId: mainModelId,
      policy: team.policy,
      model: new FakeModelClient([]),
      models: provider,
      settings: parseSettings({ executor: "host", undo: { enabled: false } }),
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      mcp: false,
      hooks: false,
      commands: false,
      profiles: [],
    });
    try {
      expect(await app.setModel("local/allowed")).toMatchObject({ ok: false });
      expect(provider.factory).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("keeps wildcard-allowed numeric switching and subsequent model requests working", async () => {
    const provider = choices();
    const app = await createRuntime(project(), {
      policy: { allowedModels: [mainModelId, "local/*"] },
      models: provider,
    });
    try {
      const number = app.modelList().findIndex((m) => m.spec === "local/allowed") + 1;
      expect(number).toBeGreaterThan(0);
      expect(await app.setModel(String(number))).toMatchObject({ ok: true });
      expect(provider.factory).toHaveBeenCalledTimes(1);
      await app.runTurn("Answer using the allowed model.", signal());
      expect(provider.client.requests).toHaveLength(1);
      expect(app.modelId).toBe("local/allowed");
    } finally {
      await app.close();
    }
  });

  it.each([{}, { allowedModels: [] }])(
    "preserves switching without an allowlist: %j",
    async (policy) => {
      const provider = choices();
      const app = await createRuntime(project(), { policy, models: provider });
      try {
        expect(await app.setModel("local/allowed")).toMatchObject({ ok: true });
        expect(provider.factory).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    },
  );

  it("resumes history with the allowed current model instead of restoring a forbidden historical model", async () => {
    const root = project();
    const historical = await createRuntime(root, {
      modelId: "forbidden/model",
      policy: {},
      model: new FakeModelClient([reply([text("Historical answer.")])]),
    });
    await historical.runTurn("Historical task.", signal());
    const id = historical.session?.id as string;
    await historical.close();
    const model = new FakeModelClient([reply([text("Allowed continuation.")])]);
    const provider = choices();
    const app = await createRuntime(root, { resume: id, model, models: provider });
    try {
      expect(app.modelId).toBe(mainModelId);
      expect(JSON.stringify(app.session?.messages)).toContain("Historical task.");
      expect(await app.setModel("forbidden/model")).toMatchObject({ ok: false });
      await app.runTurn("Continue safely.", signal());
      expect(model.requests).toHaveLength(1);
      expect(provider.factory).not.toHaveBeenCalled();
      app.newSession();
      expect(await app.switchSession(id)).toMatchObject({ ok: true });
      expect(app.modelId).toBe(mainModelId);
    } finally {
      await app.close();
    }
  });

  it.each([
    ["explore", { question: "Find the important source files." }, "forbidden/model"],
    [
      "delegate_expert",
      { language: "typescript", task: "Review the important source files." },
      "forbidden/model",
    ],
    ["explore", { question: "Find the important source files." }, "local/allowed"],
    [
      "delegate_expert",
      { language: "typescript", task: "Review the important source files." },
      "local/allowed",
    ],
  ])("enforces %s input %j with --subagent-model %s", async (tool, input, selectedModel) => {
    const provider = choices();
    const parent = new FakeModelClient([
      reply([toolUse(tool, input, "child-call")]),
      reply([text("Child request finished.")]),
    ]);
    const app = await createRuntime(project(), {
      model: parent,
      policy: { allowedModels: [mainModelId, "local/*"] },
      settings: parseSettings({
        executor: "host",
        undo: { enabled: false },
        subagents: { enabled: true },
        // MoE needs its own switch since the merge gate.
        moe: { enabled: true },
      }),
      subagentModel: { spec: selectedModel, model: provider.factory, info: modelInfo },
    });
    try {
      await app.runTurn("Ask a child to review the source.", signal());
      const allowed = selectedModel === "local/allowed";
      expect(provider.factory).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(provider.client.requests).toHaveLength(allowed ? 1 : 0);
      const result = parent.requests[1]?.messages
        .flatMap((message) => message.content)
        .find((block) => block.type === "tool_result");
      expect(result).toMatchObject({ isError: !allowed });
      if (!allowed) expect(JSON.stringify(result)).toContain("not permitted by team policy");
    } finally {
      await app.close();
    }
  });

  it.each([
    ["forbidden/model", "forbidden/model", false],
    ["sonnet", "claude-sonnet-5", false],
    ["local/allowed", "forbidden/model", true],
    ["local/allowed", "local/allowed", true],
    [undefined, "forbidden/model", false],
  ])(
    "enforces custom agent model %s resolving to %s",
    async (selected, resolved, shouldResolve) => {
      const root = project();
      const home = join(root, "empty-home");
      mkdirSync(join(home, ".garuda", "agents"), { recursive: true });
      writeFileSync(
        join(home, ".garuda", "agents", "reviewer.md"),
        `---\nname: reviewer\ndescription: Reviews source files.\n${selected === undefined ? "" : `model: ${selected}\n`}---\nReview carefully.\n`,
      );
      const provider = choices(resolved);
      const parent = new FakeModelClient([
        reply([
          toolUse(
            "agent",
            { agent: "reviewer", prompt: "Review the important source files." },
            "agent-call",
          ),
        ]),
        reply([text("Finished.")]),
      ]);
      const app = await createRuntime(root, {
        model: parent,
        policy: { allowedModels: [mainModelId, "local/*"] },
        agents: { home, resolveModel: provider.resolve },
        ...(selected === undefined
          ? { subagentModel: { spec: "forbidden/model", model: provider.factory, info: modelInfo } }
          : {}),
      });
      try {
        await app.runTurn("Ask reviewer to inspect the source.", signal());
        expect(provider.resolve.mock.calls.length > 0).toBe(shouldResolve);
        const allowed = resolved === "local/allowed";
        expect(provider.factory).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(provider.client.requests).toHaveLength(allowed ? 1 : 0);
        if (!allowed)
          expect(JSON.stringify(parent.requests[1]?.messages)).toContain(
            "not permitted by team policy",
          );
      } finally {
        await app.close();
      }
    },
  );
  it("keeps an agent's Claude alias fallback on the allowed current non-Claude model", async () => {
    const root = project();
    const home = join(root, "empty-home");
    mkdirSync(join(home, ".garuda", "agents"), { recursive: true });
    writeFileSync(
      join(home, ".garuda", "agents", "reviewer.md"),
      `---
name: reviewer
description: Reviews source files.
model: sonnet
---
Review carefully.
`,
    );
    const provider = choices();
    const parent = new FakeModelClient([
      reply([
        toolUse(
          "agent",
          { agent: "reviewer", prompt: "Review the important source files." },
          "agent-call",
        ),
      ]),
      reply([text("Child answer on the current model.")]),
      reply([text("Finished.")]),
    ]);
    const app = await createRuntime(root, {
      modelId: "local/main",
      model: parent,
      policy: { allowedModels: ["local/main"] },
      agents: { home, resolveModel: provider.resolve },
    });
    try {
      await app.runTurn("Ask reviewer to inspect the source.", signal());
      expect(provider.resolve).not.toHaveBeenCalled();
      expect(provider.factory).not.toHaveBeenCalled();
      expect(parent.requests).toHaveLength(3);
      expect(JSON.stringify(parent.requests[2]?.messages)).toContain(
        "Child answer on the current model.",
      );
    } finally {
      await app.close();
    }
  });
});
