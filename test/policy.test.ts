import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import {
  ignoredProjectPolicy,
  isCommandDisallowedByPolicy,
  isHostBlockedByPolicy,
  isModelAllowedByPolicy,
  isPathDeniedByPolicy,
  isSandboxRequiredByPolicy,
  loadTeamPolicy,
  managedPolicyPath,
  mergePolicies,
  parsePolicy,
  type TeamPolicy,
} from "../src/permissions/policy.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { CallTarget, PermissionRequest } from "../src/permissions/types.js";

const base = mkdtempSync(join(tmpdir(), "garuda-policy-test-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const signal = new AbortController().signal;
const cmd = (command: string, outsideSandbox = false): CallTarget => ({
  kind: "command",
  command,
  ...(outsideSandbox ? { outsideSandbox: true } : {}),
});
const file = (path: string): CallTarget => ({ kind: "path", path });
const url = (url: string, host: string): CallTarget => ({ kind: "url", url, host });

function request(tool: string, target: CallTarget, readOnly = false): PermissionRequest {
  return { tool, readOnly, info: { target } };
}

describe("Team Policy: parsing and validation", () => {
  it("parses valid team policy schema", () => {
    const raw = {
      disallowedCommands: ["rm -rf *", "git push *--force*"],
      requireSandbox: true,
      denyPaths: ["**/.env*", "**/*.pem"],
      allowedModels: ["claude-3-5-*", "gemini-1.5-*"],
      network: {
        blockedHosts: ["*.ru", "pastebin.com"],
        strictAllowlist: true,
      },
      limits: {
        maxSteps: 30,
        tokenBudget: 500_000,
      },
      audit: {
        enabled: true,
        level: "all",
      },
    };
    const policy = parsePolicy(raw);
    expect(policy.disallowedCommands).toEqual(["rm -rf *", "git push *--force*"]);
    expect(policy.requireSandbox).toBe(true);
    expect(policy.denyPaths).toEqual(["**/.env*", "**/*.pem"]);
    expect(policy.allowedModels).toEqual(["claude-3-5-*", "gemini-1.5-*"]);
    expect(policy.network?.strictAllowlist).toBe(true);
    expect(policy.limits?.maxSteps).toBe(30);
  });

  it("throws on invalid policy schema", () => {
    expect(() => parsePolicy({ limits: { maxSteps: -5 } })).toThrow(/Invalid policy schema/);
    expect(() => parsePolicy({ disallowedCommands: "rm -rf" })).toThrow(/Invalid policy schema/);
  });

  it("loads the managed file and ~/.garuda/policy.json, never the project's file", async () => {
    const home = join(base, "home");
    const managedDir = join(base, "managed");
    const managed = join(managedDir, "policy.json");
    mkdirSync(join(home, ".garuda"), { recursive: true });
    mkdirSync(managedDir, { recursive: true });
    expect(await loadTeamPolicy({ home, managed })).toBeUndefined();

    writeFileSync(
      join(home, ".garuda", "policy.json"),
      JSON.stringify({
        disallowedCommands: ["curl * | sh"],
        allowedModels: ["claude-*"],
        limits: { maxSteps: 10 },
      }),
    );
    writeFileSync(
      managed,
      JSON.stringify({
        disallowedCommands: ["git push *--force*"],
        requireSandbox: true,
        allowedModels: ["claude-sonnet-*"],
        limits: { maxSteps: 30, tokenBudget: 5000 },
      }),
    );
    const loaded = await loadTeamPolicy({ home, managed });
    expect(loaded?.sources).toEqual([managed, join(home, ".garuda", "policy.json")]);
    expect(loaded?.policy).toEqual({
      disallowedCommands: ["curl * | sh", "git push *--force*"],
      requireSandbox: true,
      allowedModels: ["claude-sonnet-*"],
      limits: { maxSteps: 10, tokenBudget: 5000 },
    });

    // A broken file stops Garuda and names the file (fail closed).
    writeFileSync(managed, "{ nope");
    await expect(loadTeamPolicy({ home, managed })).rejects.toThrow(managed);

    // A project's own file is only reported, never read.
    const project = join(base, "project");
    mkdirSync(join(project, ".garuda"), { recursive: true });
    expect(ignoredProjectPolicy(project)).toBeUndefined();
    writeFileSync(join(project, ".garuda", "policy.json"), "{}");
    expect(ignoredProjectPolicy(project)).toBe(join(project, ".garuda", "policy.json"));
  });

  it("knows the managed path per platform, and a merge is the stricter of the two", () => {
    expect(managedPolicyPath("darwin")).toBe("/Library/Application Support/Garuda/policy.json");
    expect(managedPolicyPath("linux")).toBe("/etc/garuda/policy.json");
    expect(managedPolicyPath("win32")).toBeUndefined();
    expect(mergePolicies(undefined, undefined)).toBeUndefined();
    expect(
      mergePolicies(
        { network: { strictAllowlist: true }, audit: { enabled: false } },
        { network: { blockedHosts: ["evil.example"] }, audit: { enabled: true } },
      ),
    ).toEqual({
      network: { blockedHosts: ["evil.example"], strictAllowlist: true },
      audit: { enabled: true },
    });
  });
});

describe("Team Policy: evaluation helpers", () => {
  const policy: TeamPolicy = {
    disallowedCommands: ["rm -rf *", "git push *--force*", "curl * | sh"],
    requireSandbox: true,
    denyPaths: ["**/.env*", "**/id_rsa*"],
    allowedModels: ["claude-3-5-*", "gpt-4o*"],
    network: {
      blockedHosts: ["*.evil.com", "pastebin.com"],
      strictAllowlist: true,
    },
  };

  it("disallows commands matching forbidden patterns or compound parts", () => {
    expect(isCommandDisallowedByPolicy(policy, "rm -rf /").disallowed).toBe(true);
    expect(isCommandDisallowedByPolicy(policy, "git push origin main --force").disallowed).toBe(
      true,
    );
    expect(isCommandDisallowedByPolicy(policy, "echo safe && rm -rf build").disallowed).toBe(true);
    expect(isCommandDisallowedByPolicy(policy, "echo 'hello world'").disallowed).toBe(false);
    expect(isCommandDisallowedByPolicy(policy, "pnpm test").disallowed).toBe(false);
  });

  it("enforces mandatory sandbox", () => {
    expect(isSandboxRequiredByPolicy(policy, true).disallowed).toBe(true);
    expect(isSandboxRequiredByPolicy(policy, false).disallowed).toBe(false);
  });

  it("denies sensitive paths matching policy patterns", () => {
    expect(isPathDeniedByPolicy(policy, "config/.env.prod").denied).toBe(true);
    expect(isPathDeniedByPolicy(policy, "home/user/id_rsa").denied).toBe(true);
    expect(isPathDeniedByPolicy(policy, "src/index.ts").denied).toBe(false);
  });

  it("verifies permitted models", () => {
    expect(isModelAllowedByPolicy(policy, "claude-3-5-sonnet-20241022").allowed).toBe(true);
    expect(isModelAllowedByPolicy(policy, "gpt-4o-mini").allowed).toBe(true);
    expect(isModelAllowedByPolicy(policy, "claude-3-opus-20240229").allowed).toBe(false);
  });

  it("blocks forbidden network hosts", () => {
    expect(isHostBlockedByPolicy(policy, "sub.evil.com").blocked).toBe(true);
    expect(isHostBlockedByPolicy(policy, "pastebin.com").blocked).toBe(true);
    expect(isHostBlockedByPolicy(policy, "github.com").blocked).toBe(false);
  });
});

describe("Team Policy: PermissionEngine enforcement", () => {
  it("policy disallowedCommands overrides settings allow rule and auto approver", async () => {
    const approver = new AutoApprover("once");
    const policy: TeamPolicy = {
      disallowedCommands: ["rm -rf *"],
    };
    const engine = new PermissionEngine({
      root: "/repo",
      approver,
      policy,
      settings: parseSettings({
        permissions: {
          allow: ["bash(rm -rf*)"], // developer tried to allow it locally
        },
      }),
    });

    const decision = await engine.check(request("bash", cmd("rm -rf dist")), signal);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.by).toBe("policy");
      expect(decision.reason).toContain("disallowed by team policy");
    }
  });

  it("requireSandbox blocks unsandboxed execution", async () => {
    const approver = new AutoApprover("once");
    const policy: TeamPolicy = {
      requireSandbox: true,
    };
    const engine = new PermissionEngine({
      root: "/repo",
      approver,
      policy,
    });

    const decision = await engine.check(request("bash", cmd("echo 123", true)), signal);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.by).toBe("policy");
      expect(decision.reason).toContain("The team policy requires the OS sandbox");
    }
    // In the sandbox it runs.
    const inside = new PermissionEngine({ root: "/repo", approver, policy, isolation: "os" });
    expect((await inside.check(request("bash", cmd("echo 123")), signal)).allowed).toBe(true);
  });

  it("policy denyPaths blocks file operations even if allow rule exists", async () => {
    const approver = new AutoApprover("once");
    const policy: TeamPolicy = {
      denyPaths: ["**/.env*"],
    };
    const engine = new PermissionEngine({
      root: "/repo",
      approver,
      policy,
      settings: parseSettings({
        permissions: {
          allow: ["read_file(.env)"],
        },
      }),
    });

    const decision = await engine.check(request("read_file", file(".env"), true), signal);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.by).toBe("policy");
      expect(decision.reason).toContain("disallowed by team policy");
    }
  });

  it("strictAllowlist blocks unauthorized network hosts without asking user", async () => {
    const approver = new AutoApprover("once");
    const policy: TeamPolicy = {
      network: {
        strictAllowlist: true,
      },
    };
    const engine = new PermissionEngine({
      root: "/repo",
      approver,
      policy,
      settings: parseSettings({
        permissions: {
          allow: ["web_fetch(docs.python.org)"],
        },
      }),
    });

    // Allowed host passes
    const allowed = await engine.check(
      request("web_fetch", url("https://docs.python.org", "docs.python.org")),
      signal,
    );
    expect(allowed.allowed).toBe(true);

    // Unlisted host blocked immediately by policy without asking approver
    const blocked = await engine.check(
      request("web_fetch", url("https://untrusted.com", "untrusted.com")),
      signal,
    );
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.by).toBe("policy");
      expect(blocked.reason).toContain("strict policy prohibits user overrides");
    }
  });
});

describe("Team Policy: limits never change shared settings (merge gate)", () => {
  it("returns a new object and leaves DEFAULT_SETTINGS and the caller's settings as they were", async () => {
    const { withPolicyLimits } = await import("../src/app/runtime.js");
    const { DEFAULT_SETTINGS } = await import("../src/permissions/settings.js");
    const before = JSON.stringify(DEFAULT_SETTINGS);
    const capped = withPolicyLimits(DEFAULT_SETTINGS, {
      limits: { maxSteps: 3, tokenBudget: 1000 },
    });
    expect(capped).toMatchObject({ maxSteps: 3, tokenBudget: 1000 });
    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    const own = parseSettings({ limits: { maxSteps: 50, tokenBudget: 5000 } });
    expect(withPolicyLimits(own, { limits: { maxSteps: 10 } })).toMatchObject({
      maxSteps: 10,
      tokenBudget: 5000,
    });
    expect(own.maxSteps).toBe(50);
    expect(withPolicyLimits(own, undefined)).toBe(own);
  });

  it("caps the subagent and MoE limits too, also the defaults (0.14, review)", async () => {
    const { withPolicyLimits } = await import("../src/app/runtime.js");
    // A project's settings asked for far more than the policy allows.
    const own = parseSettings({
      subagents: { enabled: true, maxSteps: 100, tokenBudget: 50_000_000 },
      moe: { enabled: true, maxSteps: 200, tokenBudget: 1_000_000_000 },
    });
    const capped = withPolicyLimits(own, { limits: { maxSteps: 5, tokenBudget: 1000 } });
    expect(capped.subagents).toEqual({ enabled: true, maxSteps: 5, tokenBudget: 1000 });
    expect(capped.moe).toEqual({ enabled: true, maxSteps: 5, tokenBudget: 1000 });
    // No subagent settings: the defaults (20 steps, 150k tokens) are capped.
    const plain = withPolicyLimits(parseSettings({}), { limits: { tokenBudget: 1000 } });
    expect(plain.subagents).toEqual({ maxSteps: 20, tokenBudget: 1000 });
    expect(plain.moe).toBeUndefined();
  });
});
