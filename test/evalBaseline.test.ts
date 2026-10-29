import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { claudeCodeAgent } from "../src/cli/evalCommand.js";
import {
  type ClaudeCodeAgent,
  claudeCommand,
  parseClaudeResult,
} from "../src/evals/agents/claudeCode.js";
import { compareReports, formatComparison, type LoadedReport } from "../src/evals/compare.js";
import { runEvalTask } from "../src/evals/runner.js";
import type { EvalTask } from "../src/evals/types.js";
import { resolveModel } from "../src/model/providers.js";

/** T11b (0.17): the Claude Code baseline on the same tasks (docs/lld/eval-evidence.md). */

const temp = mkdtempSync(join(tmpdir(), "garuda-baseline-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const KEY = "sk-ant-test-not-a-real-key-0000";

const success = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 4,
    total_cost_usd: 0.0123,
    result: "Done.",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 50,
    },
    ...over,
  });

describe("Claude Code's command and result", () => {
  it("the command: print mode, JSON, the model, the turns and bypassPermissions; the prompt is one word", () => {
    const agent: ClaudeCodeAgent = {
      name: "claude-code",
      command: "/bin/claude",
      model: "claude-haiku-5-5",
      env: {},
    };
    const cmd = claudeCommand(agent, "Fix it; don't stop", 50);
    expect(cmd).toBe(
      `'/bin/claude' -p 'Fix it; don'\\''t stop' --output-format json --model 'claude-haiku-5-5' --max-turns 50 --permission-mode bypassPermissions`,
    );
  });

  it("parses turns, tokens, cache reads and cost; the last JSON line counts", () => {
    expect(parseClaudeResult(`some log line\n${success()}\n`)).toEqual({
      stopReason: "done",
      steps: 4,
      tokens: 1000,
      cacheReadTokens: 800,
      costUsd: 0.0123,
    });
    expect(parseClaudeResult(success({ subtype: "error_max_turns" })).stopReason).toBe("max_steps");
    const failed = parseClaudeResult(
      success({ subtype: "error_during_execution", is_error: true, result: "boom" }),
    );
    expect(failed).toMatchObject({ stopReason: "error", reason: "Claude Code failed: boom" });
    // No JSON: an error run with an unknown cost.
    expect(parseClaudeResult("Error: not logged in")).toMatchObject({
      stopReason: "error",
      costUsd: undefined,
      reason: expect.stringMatching(/no JSON result: Error: not logged in/),
    });
  });
});

/** A fake `claude`: checks what Garuda gives it, records it in seen.txt, then solves the task. */
function fakeClaude(json: string): string {
  const bin = mkdtempSync(join(temp, "bin-"));
  const path = join(bin, "claude");
  writeFileSync(
    path,
    `#!/bin/sh
args="$*"
case "$args" in *"--permission-mode bypassPermissions"*) mode=ok ;; *) mode=missing ;; esac
case "$args" in *"--max-turns 7"*) turns=ok ;; *) turns=missing ;; esac
[ "$ANTHROPIC_API_KEY" = "${KEY}" ] && key=ok || key=missing
[ -d "$CLAUDE_CONFIG_DIR" ] && [ -f "$CLAUDE_CONFIG_DIR/.claude.json" ] && config=ok || config=missing
printf 'mode=%s turns=%s key=%s config=%s dir=%s traffic=%s\\n' "$mode" "$turns" "$key" "$config" "$CLAUDE_CONFIG_DIR" "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" > '${bin}/seen.txt'
printf '42\\n' > answer.txt
printf 'x\\n' > extra.txt
mkdir -p .claude && printf '{}' > .claude/settings.local.json
printf '%s\\n' '${json}'
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("the baseline runs through the runner, with the same grading", () => {
  const task: EvalTask = {
    id: "answer",
    title: "answer",
    prompt: "Write 42 into answer.txt.",
    files: { "answer.txt": "?\n" },
    check: "grep -q 42 answer.txt",
    solution: { "answer.txt": "42\n" },
  };

  it("runs claude in the scratch folder with a fresh config folder and the key in its environment only", async () => {
    const out = join(temp, "out");
    const agent: ClaudeCodeAgent = {
      name: "claude-code",
      command: fakeClaude(success()),
      model: "claude-haiku-5-5",
      env: { ANTHROPIC_API_KEY: KEY },
    };
    const r = await runEvalTask(task, {
      modelId: "claude-haiku-5-5",
      model: () => {
        throw new Error("the baseline must not call Garuda's model");
      },
      agent,
      maxSteps: 7,
      outDir: out,
    });
    expect(r.reason).toBeUndefined();
    expect(r).toMatchObject({
      passed: true,
      stopReason: "done",
      steps: 4,
      tokens: 1000,
      costUsd: 0.0123,
    });
    expect(r.cacheReadTokens).toBe(800);
    // Claude Code's own .claude folder is not a change of the task; extra.txt is an unexpected one.
    expect(r.changed).toEqual(["answer.txt", "extra.txt"]);
    expect(r.unexpected).toEqual(["extra.txt"]);
    // Its JSON result is kept like a session file.
    expect(r.sessionFile).toBe(join(out, "answer.claude.json"));
    expect(JSON.parse(readFileSync(r.sessionFile ?? "", "utf8"))).toMatchObject({ num_turns: 4 });
    // The key never lands in the result or the saved output.
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(readFileSync(r.sessionFile ?? "", "utf8")).not.toContain(KEY);

    const seen = readFileSync(join(agent.command, "..", "seen.txt"), "utf8");
    expect(seen).toMatch(/mode=ok turns=ok key=ok config=ok/);
    expect(seen).toContain("traffic=1");
    const dir = /dir=(\S+)/.exec(seen)?.[1] ?? "";
    // A new folder in the temp folder, not the user's ~/.claude.
    expect(dir.startsWith(join(tmpdir(), "garuda-claude-config-"))).toBe(true);
    // The config folder is removed after the run.
    expect(existsSync(dir)).toBe(false);
  });

  it("no JSON result: an error run with an unknown cost; max turns: the step limit", async () => {
    const broken = await runEvalTask(task, {
      modelId: "x",
      model: () => {
        throw new Error("no");
      },
      agent: { name: "claude-code", command: fakeClaude("not json"), model: "m", env: {} },
    });
    expect(broken).toMatchObject({ passed: false, stopReason: "error", costUsd: undefined });
    expect(broken.reason).toMatch(/no JSON result/);
    const capped = await runEvalTask(task, {
      modelId: "x",
      model: () => {
        throw new Error("no");
      },
      agent: {
        name: "claude-code",
        command: fakeClaude(success({ subtype: "error_max_turns" })),
        model: "m",
        env: {},
      },
    });
    expect(capped.stopReason).toBe("max_steps");
  });
});

describe("garuda eval --agent claude-code: what it refuses", () => {
  const anthropic = resolveModel("claude-haiku-5-5");

  it("a model that is not Claude, and options that change Garuda only", async () => {
    const other = resolveModel("ollama/qwen3");
    expect(await claudeCodeAgent({}, other)).toMatch(/needs a Claude model/);
    expect(await claudeCodeAgent({ batch: "on", index: "all" }, anthropic)).toMatch(
      /--index, --batch change Garuda only/,
    );
  });

  it("no key, or no claude on PATH", async () => {
    const before = { key: process.env.ANTHROPIC_API_KEY, path: process.env.PATH };
    try {
      delete process.env.ANTHROPIC_API_KEY;
      expect(await claudeCodeAgent({}, anthropic)).toMatch(/set ANTHROPIC_API_KEY/);
      process.env.ANTHROPIC_API_KEY = KEY;
      process.env.PATH = join(temp, "empty-path");
      expect(await claudeCodeAgent({}, anthropic)).toMatch(/not on PATH/);
      const bin = join(temp, "bin-path");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.9.0 (Claude Code)'\n");
      chmodSync(join(bin, "claude"), 0o755);
      process.env.PATH = `${bin}:${before.path ?? ""}`;
      const agent = await claudeCodeAgent({}, anthropic);
      expect(agent).toMatchObject({
        name: "claude-code",
        model: "claude-haiku-5-5",
        version: "2.9.0 (Claude Code)",
      });
      expect((agent as ClaudeCodeAgent).env.ANTHROPIC_API_KEY).toBe(KEY);
    } finally {
      if (before.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before.key;
      process.env.PATH = before.path;
    }
  });
});

describe("compare polish (the user's live run)", () => {
  it("a zero difference prints as 0 pts, and a flat interval gets a note", () => {
    const rep = (path: string): LoadedReport => ({
      path,
      schema: 2,
      model: "m",
      seed: 1,
      tasks: { a: "h", b: "h2" },
      results: ["a", "a", "a", "b", "b", "b"].map((id) => ({
        id,
        title: id,
        passed: true,
        stopReason: "done",
        steps: 1,
        tokens: 1,
        costUsd: 0.001,
        durationMs: 1,
      })),
    });
    const result = compareReports(rep("a"), rep("b"));
    if ("problems" in result) throw new Error("refused");
    const text = formatComparison(rep("a"), rep("b"), result.comparison);
    expect(text).toContain("B − A 0 pts (95% paired interval 0 pts to 0 pts;");
    expect(text).not.toContain("±");
    expect(text).toContain(
      "Every draw gave the same difference, so the interval shows no uncertainty",
    );
  });
});
