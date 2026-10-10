import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { FakeModelClient, reply, text } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { mergePolicies, parsePolicy, withProfile } from "../src/permissions/policy.js";
import { parseSettings } from "../src/permissions/settings.js";
import { createExecutor, findOsSandbox, StrictProfileError } from "../src/sandbox/index.js";
import { FileSessionStore } from "../src/session/store.js";
import { createBashTool } from "../src/tools/bash.js";

/** The strict profile (0.17, review T7; docs/lld/bounded-changes.md). */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-strict-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let count = 0;
function project(): string {
  const root = join(base, `p${count++}`);
  mkdirSync(root, { recursive: true });
  return root;
}

const noSandbox = () => ({ problem: "bubblewrap (bwrap) is not installed.", fix: "unused" });

describe("the executor in the strict profile", () => {
  it("no OS sandbox: Garuda stops with the reason, and never offers the host", () => {
    // Negative control: without strict, the same machine falls back to the host with a notice.
    const fallback = createExecutor("auto", noSandbox);
    expect(fallback.executor.isolation).toBe("none");
    expect(fallback.notice).toContain("No OS sandbox");

    const run = () => createExecutor("auto", noSandbox, true, "linux");
    expect(run).toThrow(StrictProfileError);
    expect(run).toThrow(/strict profile requires the OS sandbox.*bwrap.*Install bubblewrap/s);
    expect(run).not.toThrow(/"executor": "host" in/);
    expect(() => createExecutor("os", noSandbox, true)).toThrow(StrictProfileError);
  });

  it('"executor": "host" is an error in the strict profile', () => {
    expect(createExecutor("host", noSandbox).executor.isolation).toBe("none");
    expect(() => createExecutor("host", noSandbox, true)).toThrow(/"executor" is "host"/);
  });
});

describe("where the strict profile comes from", () => {
  it("a policy file sets it; a strict value wins in a merge", () => {
    expect(parsePolicy({ profile: "strict" }).profile).toBe("strict");
    expect(() => parsePolicy({ profile: "loose" })).toThrow();
    expect(mergePolicies({ profile: "default" }, { profile: "strict" })?.profile).toBe("strict");
    expect(mergePolicies({ profile: "strict" }, { profile: "default" })?.profile).toBe("strict");
    expect(mergePolicies({ profile: "default" }, {})?.profile).toBe("default");
  });

  it("a project can turn it on, never off; strict also requires the sandbox", () => {
    expect(withProfile(undefined, undefined)).toBeUndefined();
    expect(withProfile(undefined, "strict")).toEqual({ profile: "strict", requireSandbox: true });
    expect(withProfile({ profile: "strict" }, "default")).toEqual({
      profile: "strict",
      requireSandbox: true,
    });
    expect(withProfile({ denyPaths: ["x"] }, "default")).toEqual({ denyPaths: ["x"] });
    expect(parseSettings({ profile: "strict" }).profile).toBe("strict");
  });
});

describe("the bash tool in the strict profile", () => {
  it("has no outside_sandbox, and a call that sends it fails the input check", () => {
    const normal = createBashTool();
    const strict = createBashTool({ strict: true });
    // Negative control: the normal tool takes it.
    expect(normal.inputSchema.safeParse({ command: "ls", outside_sandbox: true }).success).toBe(
      true,
    );
    expect(strict.inputSchema.safeParse({ command: "ls" }).success).toBe(true);
    expect(strict.inputSchema.safeParse({ command: "ls", outside_sandbox: true }).success).toBe(
      false,
    );
    expect(strict.description).toContain("No command runs outside the sandbox");
    expect(strict.description).not.toContain("outside_sandbox");
  });
});

function runtime(
  root: string,
  settings: Record<string, unknown>,
  policy?: { profile: "strict" },
  model = new FakeModelClient([]),
): Promise<Runtime> {
  return Runtime.create({
    root,
    modelId: "claude-opus-5-5",
    model: async () => model,
    approver: new AutoApprover("once"),
    store: new FileSessionStore(root),
    settings: parseSettings(settings),
    ...(policy === undefined ? {} : { policy }),
    mcp: false,
    hooks: false,
    profiles: [],
  });
}

describe("a runtime in the strict profile", () => {
  it('stops at startup with "executor": "host", from the policy or the project', async () => {
    // Negative control: without strict, the host executor starts.
    const plain = await runtime(project(), { executor: "host" });
    expect(plain.executor.isolation).toBe("none");
    await plain.close();

    await expect(runtime(project(), { executor: "host" }, { profile: "strict" })).rejects.toThrow(
      StrictProfileError,
    );
    await expect(runtime(project(), { executor: "host", profile: "strict" })).rejects.toThrow(
      StrictProfileError,
    );
  });

  const found = findOsSandbox();
  it.runIf("executor" in found)(
    "with a sandbox: the prompt and the bash tool have no outside_sandbox",
    async () => {
      const model = new FakeModelClient([reply([text("ok")])]);
      const r = await runtime(project(), {}, { profile: "strict" }, model);
      expect(r.executor.isolation).not.toBe("none");
      expect(r.system).toContain("No command runs outside the sandbox (strict profile)");
      expect(r.system).not.toContain("outside_sandbox");
      expect(r.teamPolicy).toMatchObject({ profile: "strict", requireSandbox: true });
      await r.runTurn("hi", new AbortController().signal);
      const bash = model.requests[0]?.tools.find((t) => t.name === "bash");
      expect(JSON.stringify(bash?.inputSchema)).toContain('"command"');
      expect(JSON.stringify(bash)).not.toContain("outside_sandbox");
      await r.close();
    },
  );
});
