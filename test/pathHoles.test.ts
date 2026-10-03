/**
 * Path holes from Garuda's own review (2026-10, patch 0130): a symbolic link with another name,
 * letter case on macOS and Windows, and the team policy's denyPaths for commands (K6). Temp folders
 * only; the OS sandbox part runs where this machine has one.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { toolUse } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import type { TeamPolicy } from "../src/permissions/policy.js";
import { pathMatches } from "../src/permissions/rules.js";
import { policyDeniedPaths } from "../src/permissions/sandboxPaths.js";
import { isSensitive } from "../src/permissions/sensitive.js";
import { findOsSandbox } from "../src/sandbox/index.js";
import { defaultTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { toolContext } from "./helpers.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-path-holes-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;

function project() {
  const root = join(base, `p${n++}`);
  mkdirSync(join(root, "secret"), { recursive: true });
  writeFileSync(join(root, ".env"), "API_TOKEN=envMarker\n");
  writeFileSync(join(root, "secret", "plan.txt"), "policyMarker\n");
  writeFileSync(join(root, "public.txt"), "publicMarker\n");
  symlinkSync(".env", join(root, "env-link.txt"));
  symlinkSync("secret/plan.txt", join(root, "plan-link.txt"));
  return root;
}
const policy: TeamPolicy = { denyPaths: ["secret/**"] };

function tools(root: string) {
  const permissions = new PermissionEngine({ root, approver: new AutoApprover("once"), policy });
  const registry = new ToolRegistry(defaultTools());
  return (name: string, input: Record<string, unknown>) =>
    registry.execute(toolUse(name, input), toolContext(root, { permissions }));
}

describe("a symbolic link gets the denials of the file it reaches", () => {
  it("read_file through a link to .env or to a policy-denied file is denied", async () => {
    const run = tools(project());
    const env = await run("read_file", { path: "env-link.txt" });
    expect(env.isError).toBe(true);
    expect(env.content).toMatch(/env-link\.txt leads to \.env.*sensitive/);
    const plan = await run("read_file", { path: "plan-link.txt" });
    expect(plan.isError).toBe(true);
    expect(plan.content).toMatch(/team policy/);
    // Positive control.
    expect((await run("read_file", { path: "public.txt" })).content).toContain("publicMarker");
  });

  it("grep does not search through such a link, nor a link out of the root", async () => {
    const root = project();
    const outside = join(base, `outside${n++}.txt`);
    writeFileSync(outside, "outsideMarker\n");
    symlinkSync(outside, join(root, "out-link.txt"));
    const out = (await tools(root)("grep", { pattern: "Marker", mode: "content" })).content;
    expect(out).not.toMatch(/envMarker|policyMarker|outsideMarker/);
    expect(out).toContain("publicMarker");
  });
});

describe("letter case on file systems that ignore it", () => {
  it("matches .ENV as .env when case is ignored, and not otherwise", () => {
    expect(isSensitive(".ENV", true)).toBe(true);
    expect(isSensitive("config/.Env.local", true)).toBe(true);
    expect(isSensitive(".ENV", false)).toBe(false);
    expect(pathMatches("secret/**", "Secret/plan.txt", true)).toBe(true);
    expect(pathMatches("secret/**", "Secret/plan.txt", false)).toBe(false);
  });
});

describe("the team policy's denyPaths also binds commands (K6)", () => {
  it("names the denied files and folders for the sandbox, read and write", () => {
    const root = project();
    mkdirSync(join(root, "node_modules", "secret"), { recursive: true });
    expect(policyDeniedPaths(root, ["secret/**"])).toEqual([join(root, "secret", "plan.txt")]);
    expect(policyDeniedPaths(root, ["secret"])).toContain(join(root, "secret"));
    const engine = new PermissionEngine({ root, approver: new AutoApprover("once"), policy });
    const exec = engine.execPolicy(1_000);
    expect(exec.denyReadPaths).toContain(join(root, "secret", "plan.txt"));
    expect(exec.denyWritePaths).toContain(join(root, "secret", "plan.txt"));
    // No policy: nothing added.
    const plain = new PermissionEngine({ root, approver: new AutoApprover("once") }).execPolicy(1);
    expect(plain.denyReadPaths).not.toContain(join(root, "secret", "plan.txt"));
  });

  const found = findOsSandbox();
  const executor = "executor" in found ? found.executor : undefined;
  it.runIf(executor !== undefined)(
    "cat in the OS sandbox cannot read the denied file",
    async () => {
      const root = project();
      const engine = new PermissionEngine({ root, approver: new AutoApprover("once"), policy });
      const run = (command: string) =>
        (executor as NonNullable<typeof executor>).run(command, engine.execPolicy(10_000));
      const denied = await run("cat secret/plan.txt");
      expect(denied.stdout.text).not.toContain("policyMarker");
      expect(denied.exitCode).not.toBe(0);
      expect((await run("cat public.txt")).stdout.text).toContain("publicMarker");
    },
  );
});
