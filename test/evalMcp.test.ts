import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chooseMcp, claudeCodeAgent } from "../src/cli/evalCommand.js";
import { compareReports, formatComparison, type LoadedReport } from "../src/evals/compare.js";
import {
  formatReport,
  isSetupFailure,
  MCP_NOT_STARTED,
  MCP_PREPARE_FAILED,
  runEvalTask,
} from "../src/evals/runner.js";
import type { EvalResult, EvalTask } from "../src/evals/types.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { resolveModel } from "../src/model/providers.js";

/** `garuda eval --mcp <server> [--mcp-prepare <command>]` (0.17): an MCP A/B, e.g. Graphify. */

const FIXTURE = join(import.meta.dirname, "fixtures", "mcpServer.mjs");
const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-eval-mcp-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;

/** A fake home folder with this ~/.garuda/mcp.json: never the user's own. */
function home(servers: Record<string, unknown>): string {
  const dir = join(base, `home${n++}`);
  mkdirSync(join(dir, ".garuda"), { recursive: true });
  writeFileSync(join(dir, ".garuda", "mcp.json"), JSON.stringify({ servers }));
  return dir;
}

const fixture = { command: process.execPath, args: [FIXTURE] };

const task: EvalTask = {
  id: "mcp-probe",
  title: "MCP probe",
  prompt: "Echo once, then stop.",
  files: { "README.md": "x\n" },
  check: "true",
  solution: {},
};

const echoThenStop = () =>
  new FakeModelClient([
    reply([toolUse("mcp__fake__echo", { text: "hi" }, "m1")]),
    reply([text("Done.")]),
  ]);

describe("the runner with one MCP server", () => {
  it("offers only the named server's tools, and counts their calls", async () => {
    const h = home({ fake: fixture, other: fixture });
    const model = echoThenStop();
    const result = await runEvalTask(task, {
      modelId: "fake",
      model: () => model,
      mcp: { server: "fake", home: h },
    });
    expect(result).toMatchObject({ passed: true, mcpCalls: 1 });
    const tools = model.requests[0]?.tools.map((t) => t.name) ?? [];
    expect(tools).toContain("mcp__fake__echo");
    expect(tools.filter((t) => t.startsWith("mcp__other__"))).toEqual([]);
  }, 60_000);

  it("without --mcp, no server starts and nothing is counted", async () => {
    const h = home({ fake: fixture });
    const model = new FakeModelClient([reply([text("Done.")])]);
    const result = await runEvalTask(task, { modelId: "fake", model: () => model });
    expect(result.mcpCalls).toBeUndefined();
    expect(model.requests[0]?.tools.some((t) => t.name.startsWith("mcp__"))).toBe(false);
    expect(h).toBeDefined();
  }, 60_000);

  it("the prepare command runs first; what it writes is not the agent's change", async () => {
    const h = home({ fake: fixture });
    const result = await runEvalTask(task, {
      modelId: "fake",
      model: echoThenStop,
      mcp: {
        server: "fake",
        home: h,
        prepare: "mkdir -p graph-out && echo graph > graph-out/g.json",
      },
    });
    expect(result.passed).toBe(true);
    expect(result.changed).toEqual([]);
  }, 60_000);

  it("a failed prepare command stops the run before the agent, and the eval", async () => {
    const h = home({ fake: fixture });
    const model = echoThenStop();
    const result = await runEvalTask(task, {
      modelId: "fake",
      model: () => model,
      mcp: { server: "fake", home: h, prepare: "echo no graph >&2; exit 4" },
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(`${MCP_PREPARE_FAILED}\nno graph`);
    expect(model.requests).toHaveLength(0);
    expect(isSetupFailure(result)).toBe(true);
  }, 60_000);

  it("a server that does not start fails the run and stops the eval", async () => {
    const h = home({ fake: { command: "/nonexistent/garuda-mcp-server" } });
    const result = await runEvalTask(task, {
      modelId: "fake",
      model: () => new FakeModelClient([reply([text("Done.")])]),
      mcp: { server: "fake", home: h },
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(new RegExp(`^${MCP_NOT_STARTED} "fake": `));
    expect(isSetupFailure(result)).toBe(true);
  }, 60_000);
});

describe("choosing the server", () => {
  it("takes an enabled server from the user's own file, with its prepare command", async () => {
    const h = home({ graphify: fixture, off: { ...fixture, enabled: false } });
    expect(await chooseMcp({ mcp: "graphify", mcpPrepare: "graphify update ." }, h)).toEqual({
      server: "graphify",
      home: h,
      prepare: "graphify update .",
    });
    expect(await chooseMcp({}, h)).toBeUndefined();
  });

  it("refuses an unknown or disabled server, and a prepare command alone", async () => {
    const h = home({ graphify: fixture, off: { ...fixture, enabled: false } });
    expect(await chooseMcp({ mcp: "nope" }, h)).toBe(
      "--mcp nope: no server of that name in ~/.garuda/mcp.json (yours: graphify, off).",
    );
    expect(await chooseMcp({ mcp: "off" }, h)).toMatch(/is disabled/);
    expect(await chooseMcp({ mcpPrepare: "x" }, h)).toBe("--mcp-prepare needs --mcp <server>.");
  });

  it("the Claude Code baseline refuses --mcp: it changes Garuda only", async () => {
    const reason = await claudeCodeAgent(
      { mcp: "graphify", mcpPrepare: "graphify update ." },
      resolveModel("claude-haiku-5-5"),
    );
    expect(reason).toBe(
      "--mcp, --mcp-prepare change Garuda only; leave them out of the baseline run.",
    );
  });
});

describe("the reports", () => {
  const run = (id: string, mcpCalls?: number): EvalResult => ({
    id,
    title: id,
    passed: true,
    stopReason: "done",
    steps: 3,
    tokens: 100,
    costUsd: 0.001,
    durationMs: 1000,
    ...(mcpCalls === undefined ? {} : { mcpCalls }),
  });

  it("the run report says how often the agent used the server", () => {
    expect(formatReport([run("a", 2), run("b", 0), run("c", 1)])).toContain(
      "MCP tool calls: 3 in 2 of 3 runs",
    );
    expect(formatReport([run("a", 0)])).toContain(
      "MCP tool calls: 0 in 0 of 1 runs (the agent never used the server)",
    );
    expect(formatReport([run("a")])).not.toContain("MCP tool calls");
  });

  it("compare names the arms' servers and their use", () => {
    const report = (path: string, mcp: string | undefined, calls?: number): LoadedReport => ({
      path,
      schema: 2,
      model: "m",
      seed: 1,
      tasks: { a: "h" },
      results: [run("a", calls), run("a", calls), run("a", calls)],
      mcp,
    });
    const a = report("a", undefined);
    const b = report("b", "graphify", 2);
    const r = compareReports(a, b);
    if ("problems" in r) throw new Error(r.problems.join(" "));
    expect(r.comparison.notes.join(" ")).toContain(
      "The arms differ in the MCP server: A none, B graphify.",
    );
    expect(formatComparison(a, b, r.comparison)).toContain("MCP tool calls 6 in 3 of 3 runs");
  });
});
