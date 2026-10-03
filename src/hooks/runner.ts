import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AuditLogger } from "../audit/logger.js";
import { capText, cleanText, neutralizeTags } from "../mcp/sanitize.js";
import { ruleMatches } from "../permissions/rules.js";
import type { ApprovalRequest, PermissionGate } from "../permissions/types.js";
import type { Executor } from "../sandbox/types.js";
import type { HookCall, ToolHooks, ToolOutcome } from "../tools/types.js";
import type { Hook, HookEvent } from "./config.js";

const OUTPUT_BYTES = 8_000;
const FEEDBACK_CHARS = 4_000;

export interface HookRunnerOptions {
  root: string;
  hooks: readonly Hook[];
  executor: Executor;
  permissions: PermissionGate;
  notify?: (text: string) => void;
  /** Each hook run goes to the audit log (0.14, review). */
  audit?: AuditLogger;
}

/**
 * Runs the user's hooks around tool calls (0.2). Rules (user decisions):
 * - preToolUse: exit 0 lets the call go on; exit 2 blocks it, and stderr tells the model why.
 *   Any other failure (other exit code, timeout, crash) also blocks it: fail closed.
 *   A hook can never approve a call. It runs before the permission check.
 * - postToolUse: exit 2 adds stderr to the result as <hook_feedback> for the model.
 *   Other failures only warn the user.
 * - Hooks run through the Executor, in the OS sandbox (no network unless the hook says so).
 *   They get the event data in a JSON file ($GARUDA_HOOK_INPUT) and in a few variables.
 * - The team policy holds for hooks too (0.14, review): a command that requireSandbox or
 *   disallowedCommands refuses does not run, and counts as a failed hook. Each run is audited.
 */
export class HookRunner implements ToolHooks {
  constructor(private readonly options: HookRunnerOptions) {}

  get count(): number {
    return this.options.hooks.length;
  }

  async before(call: HookCall, signal: AbortSignal): Promise<string | undefined> {
    for (const hook of this.matching("preToolUse", call)) {
      const r = await this.run(hook, call, undefined, signal);
      if (r.exitCode === 0 && !r.timedOut) continue;
      const stderr = clean(r.stderr);
      if (r.exitCode === 2 && !r.timedOut)
        return stderr === "" ? "a preToolUse hook said no." : stderr;
      const why = r.timedOut
        ? `it timed out after ${hook.def.timeoutMs} ms`
        : `exit code ${r.exitCode ?? r.signal}`;
      this.options.notify?.(
        `A preToolUse hook failed (${why}), so Garuda blocked ${call.tool}: ${hook.def.command}`,
      );
      return `a preToolUse hook failed (${why}), so Garuda blocked the call${stderr === "" ? "" : `: ${stderr}`}`;
    }
    return undefined;
  }

  async after(call: HookCall, outcome: ToolOutcome, signal: AbortSignal): Promise<ToolOutcome> {
    let content = outcome.content;
    for (const hook of this.matching("postToolUse", call)) {
      const r = await this.run(hook, call, outcome, signal);
      if (r.exitCode === 2 && !r.timedOut) {
        content += `\n<hook_feedback>\n${clean(r.stderr)}\n</hook_feedback>`;
      } else if (r.exitCode !== 0 || r.timedOut) {
        const why = r.timedOut ? "timed out" : `exit code ${r.exitCode ?? r.signal}`;
        this.options.notify?.(`A postToolUse hook failed (${why}): ${hook.def.command}`);
      }
    }
    return { ...outcome, content };
  }

  describe(): string[] {
    return this.options.hooks.map(
      (h) =>
        `${h.event} [${h.source}] ${h.def.tools.length === 0 ? "all tools" : h.def.tools.join(", ")}: ${h.def.command}`,
    );
  }

  private matching(event: HookEvent, call: HookCall): Hook[] {
    const target = call.info?.target;
    return this.options.hooks.filter(
      (h) =>
        h.event === event &&
        (h.rules.length === 0 ||
          h.rules.some((rule) => ruleMatches(rule, call.tool, target, "deny"))),
    );
  }

  private async run(
    hook: Hook,
    call: HookCall,
    outcome: ToolOutcome | undefined,
    signal: AbortSignal,
  ) {
    const { root, executor, permissions, audit } = this.options;
    const target = call.info?.target;
    const refused = permissions.commandPolicyDenial(hook.def.command, false);
    if (refused !== undefined) {
      this.options.notify?.(`The team policy refused a hook: ${hook.def.command}. ${refused}`);
      await audit?.log({
        tool: `hook:${hook.event}`,
        target: hook.def.command,
        decision: "deny_policy",
        allowed: false,
        reason: refused,
        risk: "critical",
      });
      return { exitCode: null, signal: "refused by the team policy", timedOut: false, stderr: "" };
    }
    const file = join(tmpdir(), `garuda-hook-${randomBytes(6).toString("hex")}.json`);
    const data = {
      event: hook.event,
      tool: call.tool,
      input: call.input,
      ...(target === undefined ? {} : { target }),
      ...(outcome === undefined ? {} : { result: outcome }),
      root,
    };
    await writeFile(file, JSON.stringify(data), { mode: 0o600 });
    const env: Record<string, string> = {
      GARUDA_HOOK_EVENT: hook.event,
      GARUDA_TOOL: call.tool,
      GARUDA_HOOK_INPUT: file,
    };
    if (target?.kind === "path") {
      env.GARUDA_FILE = isAbsolute(target.path) ? target.path : join(root, target.path);
    }
    if (target?.kind === "command") env.GARUDA_COMMAND = target.command;
    if (target?.kind === "url") env.GARUDA_URL = target.url;
    try {
      // A hook gets the network only when its definition says so, never the allowlist (0.13).
      const { proxy: _proxy, ...sandboxed } = permissions.execPolicy(hook.def.timeoutMs, {
        sandbox: true,
      });
      const policy = {
        ...sandboxed,
        network: hook.def.network,
        maxOutputBytes: OUTPUT_BYTES,
      };
      const started = Date.now();
      const r = await executor.run(hook.def.command, policy, { signal, env });
      await audit?.logHookRun({
        event: hook.event,
        command: hook.def.command,
        durationMs: Date.now() - started,
        exitCode: r.timedOut ? null : r.exitCode,
        network: hook.def.network,
      });
      return {
        exitCode: r.exitCode,
        signal: r.signal,
        timedOut: r.timedOut,
        stderr: r.stderr.text || r.stdout.text,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return { exitCode: null, signal: (error as Error).message, timedOut: false, stderr: "" };
    } finally {
      await rm(file, { force: true });
    }
  }
}

const clean = (text: string) => neutralizeTags(capText(cleanText(text).trim(), FEEDBACK_CHARS));

/** The consent question for a project's hooks: every command, in full. */
export function hooksConsent(
  hooks: readonly Hook[],
  file: string,
  isolation: string,
  changed: boolean,
): ApprovalRequest {
  const lines = [
    changed
      ? `The hooks in ${file} changed since you allowed them.`
      : `This project has hooks in ${file}.`,
    "Hooks run these commands around the agent's tool calls:",
    ...hooks.flatMap((h) => [
      `  ${h.event} for ${h.def.tools.length === 0 ? "every tool" : h.def.tools.join(", ")}${h.def.network ? " (network: YES)" : ""}:`,
      `    $ ${h.def.command}`,
    ]),
    isolation === "none"
      ? "  ! There is no OS sandbox on this machine: they run as you, with full access."
      : "  They run in the sandbox: writes only in this project and temp folders.",
    "Allow them only if you trust this project.",
  ];
  return {
    tool: "hooks",
    target: { kind: "input", json: JSON.stringify({ file }) },
    preview: lines.join("\n"),
    isolation: isolation as ApprovalRequest["isolation"],
    title: "Run this project's hooks?",
    labels: {
      once: "Yes, for this session only",
      session: "Yes, and remember (asks again if the file changes)",
      deny: "No, ignore the project's hooks",
    },
  };
}
