import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecPolicy, ExecResult, Executor } from "../../sandbox/types.js";

/**
 * The Claude Code baseline (0.17, T11b; docs/lld/eval-evidence.md): the same task, scratch folder,
 * time limit and grading as a Garuda run; only the agent differs.
 *
 *   claude -p <prompt> --output-format json --model <id> --max-turns <n>
 *          --permission-mode bypassPermissions
 *
 * `bypassPermissions` is safe only in Garuda's OS sandbox, so `garuda eval --agent claude-code`
 * refuses to run without one. Each run gets a new config folder (CLAUDE_CONFIG_DIR), so the user's
 * own CLAUDE.md, settings, MCP servers, hooks and history do not change the result. The API key
 * reaches the process in its environment only; it is never written to a file.
 */

export interface ClaudeCodeAgent {
  name: "claude-code";
  /** The `claude` program (an absolute path). */
  command: string;
  /** The Claude model id, the same as the Garuda arm's. */
  model: string;
  /** `claude --version`, for the report. */
  version?: string;
  /** Variables for the process only, for example ANTHROPIC_API_KEY. Never written anywhere. */
  env: Record<string, string>;
}

/** Room for the JSON result line: a cut line cannot be parsed. */
const MAX_OUTPUT_BYTES = 5_000_000;

export function claudeCommand(agent: ClaudeCodeAgent, prompt: string, maxTurns: number): string {
  return [
    quote(agent.command),
    "-p",
    quote(prompt),
    "--output-format",
    "json",
    "--model",
    quote(agent.model),
    "--max-turns",
    String(maxTurns),
    "--permission-mode",
    "bypassPermissions",
  ].join(" ");
}

export interface ClaudeOutcome {
  stopReason: string;
  steps: number;
  tokens: number;
  cacheReadTokens: number;
  costUsd: number | undefined;
  /** Why the run is an error run or failed early. */
  reason?: string;
}

/**
 * Claude Code's JSON result: `subtype` (success, error_max_turns, error_during_execution),
 * `is_error`, `num_turns`, `total_cost_usd`, `usage`. A missing or invalid result is an error run
 * with an unknown cost.
 */
export function parseClaudeResult(stdout: string): ClaudeOutcome {
  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(line ?? "") as Record<string, unknown>;
  } catch {
    return {
      stopReason: "error",
      steps: 0,
      tokens: 0,
      cacheReadTokens: 0,
      costUsd: undefined,
      reason: `Claude Code gave no JSON result: ${stdout.trim().slice(0, 300) || "no output"}`,
    };
  }
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cacheRead = n(usage.cache_read_input_tokens);
  const tokens =
    n(usage.input_tokens) +
    n(usage.output_tokens) +
    cacheRead +
    n(usage.cache_creation_input_tokens);
  const costUsd = typeof data.total_cost_usd === "number" ? data.total_cost_usd : undefined;
  const steps = n(data.num_turns);
  const subtype = typeof data.subtype === "string" ? data.subtype : "";
  const base = { steps, tokens, cacheReadTokens: cacheRead, costUsd };
  if (subtype === "error_max_turns") return { ...base, stopReason: "max_steps" };
  if (subtype === "success" && data.is_error !== true) return { ...base, stopReason: "done" };
  const text = typeof data.result === "string" ? data.result : subtype || "unknown error";
  return { ...base, stopReason: "error", reason: `Claude Code failed: ${text.slice(0, 300)}` };
}

/** Run Claude Code once in `policy` (the run's OS sandbox), with a new config folder. */
export async function runClaudeCode(
  executor: Executor,
  policy: ExecPolicy,
  agent: ClaudeCodeAgent,
  prompt: string,
  maxTurns: number,
  signal: AbortSignal,
): Promise<{ result: ExecResult; outcome: ClaudeOutcome }> {
  const config = await mkdtemp(join(tmpdir(), "garuda-claude-config-"));
  try {
    // No onboarding question in -p mode, and no other user's state.
    await writeFile(
      join(config, ".claude.json"),
      `${JSON.stringify({ hasCompletedOnboarding: true })}\n`,
    );
    const result = await executor.run(
      claudeCommand(agent, prompt, maxTurns),
      { ...policy, maxOutputBytes: MAX_OUTPUT_BYTES },
      {
        signal,
        env: {
          ...agent.env,
          CLAUDE_CONFIG_DIR: config,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
        },
      },
    );
    // Too slow is the agent's failure, as for Garuda; its spending is then unknown.
    const outcome: ClaudeOutcome =
      result.timedOut || result.aborted
        ? {
            stopReason: "timeout",
            steps: 0,
            tokens: 0,
            cacheReadTokens: 0,
            costUsd: undefined,
            reason: "Claude Code took longer than the task's time limit.",
          }
        : parseClaudeResult(result.stdout.text);
    if (
      outcome.stopReason === "error" &&
      result.stderr.text.trim() !== "" &&
      outcome.reason !== undefined
    ) {
      outcome.reason += `\n${result.stderr.text.trim().split("\n").slice(-3).join("\n")}`;
    }
    return { result, outcome };
  } finally {
    await rm(config, { recursive: true, force: true });
  }
}

/** One shell word. */
function quote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}
