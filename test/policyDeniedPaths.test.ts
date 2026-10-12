import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import {
  MAX_POLICY_DENIED_PATHS,
  PolicyPathsOverflow,
  policyDeniedPaths,
} from "../src/permissions/sandboxPaths.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { findOsSandbox } from "../src/sandbox/index.js";
import { bashTool } from "../src/tools/bash.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { toolContext } from "./helpers.js";

/** Team policy denyPaths in the OS sandbox: never fewer rules than matches (Codex review of 1370184). */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-denied-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let count = 0;
function project(files: string[]): string {
  const root = join(base, `p${count++}`);
  for (const file of files) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "secret");
  }
  mkdirSync(root, { recursive: true });
  return root;
}

const many = (n: number) => Array.from({ length: n }, (_, i) => `data/f${i}.txt`);

describe("policyDeniedPaths", () => {
  it("returns every match up to the limit", () => {
    const root = project(many(MAX_POLICY_DENIED_PATHS));
    expect(policyDeniedPaths(root, ["data/**"]).filter((p) => p.endsWith(".txt"))).toHaveLength(
      MAX_POLICY_DENIED_PATHS,
    );
  });

  it("more matches than the sandbox can hold: an error, never a shorter list", () => {
    const root = project(many(MAX_POLICY_DENIED_PATHS + 5));
    expect(() => policyDeniedPaths(root, ["data/**"])).toThrow(PolicyPathsOverflow);
    expect(() => policyDeniedPaths(root, ["data/**"])).toThrow(/1005|1006/);
  });

  it("a pattern that names node_modules finds files there", () => {
    const root = project(["node_modules/pkg/secret.txt", "src/a.ts"]);
    expect(policyDeniedPaths(root, ["node_modules/pkg/secret.txt"])).toEqual([
      join(root, "node_modules/pkg/secret.txt"),
    ]);
  });

  // Review of 3a9f51b (P1): the file tool refused node_modules/pkg/private.txt under
  // "**/private.txt", but the sandbox had no rule for it. The same pattern covers every folder.
  it("a wildcard pattern also finds files in node_modules and .git", () => {
    const root = project([
      "node_modules/pkg/private.txt",
      "node_modules/.pnpm/pkg@1/node_modules/pkg/private.txt",
      ".git/private.txt",
      "src/private.txt",
      "src/a.ts",
    ]);
    expect(policyDeniedPaths(root, ["**/private.txt"]).sort()).toEqual(
      [
        ".git/private.txt",
        "node_modules/.pnpm/pkg@1/node_modules/pkg/private.txt",
        "node_modules/pkg/private.txt",
        "src/private.txt",
      ].map((p) => join(root, p)),
    );
  });

  it("the command's sandbox policy denies the dependency file", () => {
    const root = project(["node_modules/pkg/private.txt"]);
    const permissions = new PermissionEngine({
      root,
      approver: new AutoApprover("once"),
      policy: { denyPaths: ["**/private.txt"] },
      isolation: "os",
    });
    const policy = permissions.execPolicy(10_000);
    const file = join(root, "node_modules/pkg/private.txt");
    expect(policy.denyReadPaths).toContain(file);
    expect(policy.denyWritePaths).toContain(file);
  });
});

describe("a command when the policy's paths cannot all be enforced", () => {
  it("does not run, and the error says why", async () => {
    const root = project(many(MAX_POLICY_DENIED_PATHS + 5));
    const permissions = new PermissionEngine({
      root,
      approver: new AutoApprover("once"),
      policy: { denyPaths: ["data/**"] },
      isolation: "os",
    });
    const registry = new ToolRegistry([bashTool]);
    const outcome = await registry.execute(
      { type: "tool_use", id: "b1", name: "bash", input: { command: "touch ran.txt" } },
      toolContext(root, { permissions, executor: new HostExecutor() }),
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toMatch(/more paths than the OS sandbox can protect/);
    expect(existsSync(join(root, "ran.txt"))).toBe(false);
  });
});

const found = findOsSandbox();
const osExecutor = "executor" in found ? found.executor : undefined;

describe.runIf(osExecutor !== undefined)("denyPaths in the OS sandbox of this machine", () => {
  it("a command cannot read a dependency file that a wildcard denies (review of 3a9f51b)", async () => {
    const root = project(["node_modules/pkg/private.txt"]);
    const permissions = new PermissionEngine({
      root,
      approver: new AutoApprover("once"),
      policy: { denyPaths: ["**/private.txt"] },
      isolation: "os",
    });
    const r = await (osExecutor as NonNullable<typeof osExecutor>).run(
      "cat node_modules/pkg/private.txt",
      permissions.execPolicy(10_000),
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.text).not.toContain("secret");
  });
});
