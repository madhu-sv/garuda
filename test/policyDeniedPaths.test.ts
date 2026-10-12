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
    // A pattern that does not name node_modules still skips it (speed).
    expect(policyDeniedPaths(root, ["**/secret.txt"])).toEqual([]);
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
