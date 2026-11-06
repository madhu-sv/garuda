import { describe, expect, it } from "vitest";
import {
  type EvalOptions,
  failureKind,
  isProviderStall,
  isSetupFailure,
  ModelWatch,
  PROVIDER_STALLED,
  runEvals,
  runEvalTask,
  withStalledRun,
} from "../src/evals/runner.js";
import type { EvalResult, EvalTask } from "../src/evals/types.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { ModelClient, ModelEvent, ModelRequest, StreamOptions } from "../src/model/types.js";

/**
 * 0.18.2: a timeout while the model's API is silent is the provider's failure, not the agent's. In
 * the user's Sonnet run, four runs timed out with a request open after 55 to 351 s of silence and
 * "Connection error" retries; they counted as the model's failures.
 */

/** A client that answers `steps` first, then never answers until the run stops. */
class StallingClient implements ModelClient {
  private readonly fake: FakeModelClient;
  constructor(steps: ConstructorParameters<typeof FakeModelClient>[0]) {
    this.fake = new FakeModelClient(steps);
  }
  async *stream(request: ModelRequest, options?: StreamOptions): AsyncIterable<ModelEvent> {
    if (this.fake.remaining > 0) {
      yield* this.fake.stream(request, options);
      return;
    }
    await new Promise((_, reject) => {
      const signal = options?.signal;
      if (signal === undefined) return;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}

const task: EvalTask = {
  id: "stall",
  title: "stall",
  prompt: "Fix it.",
  files: { "a.txt": "x\n" },
  check: "true",
  solution: {},
};
const base = (model: () => ModelClient): EvalOptions => ({
  modelId: "fake",
  model,
  executor: "host",
  taskTimeoutMs: 600,
  providerStallMs: 200,
});

describe("a timeout while the model's API is silent", () => {
  it("is an error run of kind provider, with the steps up to the stop", async () => {
    const result = await runEvalTask(
      task,
      base(() => new StallingClient([reply([toolUse("read_file", { path: "a.txt" }, "r1")])])),
    );
    expect(result.stopReason).toBe("error");
    expect(result.reason).toMatch(
      /^The model's API stalled: it sent nothing for \d+ s when the task hit/,
    );
    expect(failureKind(result)).toBe("provider");
    // The first step happened: a timeout showed 0 steps before.
    expect(result.steps).toBe(1);
  }, 20_000);

  it("is the agent's timeout when a command was running", async () => {
    const result = await runEvalTask(
      task,
      base(() => new StallingClient([reply([toolUse("bash", { command: "sleep 5" }, "b1")])])),
    );
    expect(result.stopReason).toBe("timeout");
    expect(failureKind(result)).toBe("timeout");
    expect(result.steps).toBe(1);
  }, 20_000);

  it("runs once more, and the result keeps both runs' spending", async () => {
    let calls = 0;
    const notices: string[] = [];
    const results = await runEvals([task], {
      ...base(() =>
        ++calls === 1 ? new StallingClient([]) : new FakeModelClient([reply([text("Done.")])]),
      ),
      onEvent: (_id, event) => {
        if (event.type === "notice") notices.push(event.text);
      },
    });
    expect(calls).toBe(2);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ passed: true, providerStalls: 1, attempt: 1 });
    expect(
      notices.some((n) => n.startsWith(PROVIDER_STALLED) && n.endsWith("Running it again.")),
    ).toBe(true);
  }, 20_000);
});

describe("the model watch and the stall record", () => {
  const response = (tool: boolean) => ({
    content: tool ? [toolUse("bash", { command: "x" }, "t")] : [text("ok")],
    stopReason: tool ? ("tool_use" as const) : ("end_turn" as const),
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });

  it("counts a broken, retried stream as a stall at once, and a running tool never", () => {
    const w = new ModelWatch();
    w.see({ type: "model_retry", attempt: 1, maxRetries: 2, delayMs: 1, reason: "terminated" }, 0);
    expect(w.stall(1_000, 120_000)).toMatch(/stream broke and was retried/);
    w.see(
      { type: "step_end", step: 3, usage: response(true).usage, response: response(true) },
      1_000,
    );
    w.see({ type: "tool_call", call: toolUse("bash", { command: "x" }, "t") }, 1_000);
    expect(w.stall(999_000, 120_000)).toBeUndefined();
    expect(w.steps).toBe(3);
    w.see(
      {
        type: "tool_result",
        call: toolUse("bash", { command: "x" }, "t"),
        result: { content: "", isError: false },
      } as never,
      2_000,
    );
    expect(w.stall(100_000, 120_000)).toBeUndefined();
    expect(w.stall(122_000, 120_000)).toBe("it sent nothing for 120 s");
  });

  it("with two tools in one step, the model waits only after both results", () => {
    const w = new ModelWatch();
    const call = (id: string) => toolUse("bash", { command: "x" }, id);
    w.see({ type: "step_end", step: 1, usage: response(true).usage, response: response(true) }, 0);
    // Between the response and the first tool: about to run tools, not waiting on the model.
    expect(w.stall(999_000, 120_000)).toBeUndefined();
    w.see({ type: "tool_call", call: call("a") }, 0);
    w.see({ type: "tool_call", call: call("b") }, 0);
    w.see(
      { type: "tool_result", call: call("a"), result: { content: "", isError: false } } as never,
      0,
    );
    // b still runs.
    expect(w.stall(999_000, 120_000)).toBeUndefined();
    w.see(
      { type: "tool_result", call: call("b"), result: { content: "", isError: false } } as never,
      0,
    );
    expect(w.stall(130_000, 120_000)).toBe("it sent nothing for 130 s");
  });

  it("adds the stalled run's tokens and cost, and a stall of 401 s is not a refused key", () => {
    const run = (extra: Partial<EvalResult>): EvalResult => ({
      id: "a",
      title: "a",
      passed: false,
      stopReason: "done",
      steps: 1,
      tokens: 100,
      costUsd: 0.5,
      durationMs: 1,
      ...extra,
    });
    const stalled = run({
      stopReason: "error",
      reason: `${PROVIDER_STALLED} it sent nothing for 401 s when the task hit its 10-minute limit.`,
    });
    expect(isProviderStall(stalled)).toBe(true);
    expect(isSetupFailure(stalled)).toBe(false);
    const merged = withStalledRun(run({ passed: true, tokens: 50, costUsd: 0.25 }), stalled);
    expect(merged).toMatchObject({ passed: true, tokens: 150, costUsd: 0.75, providerStalls: 1 });
    expect(withStalledRun(run({ costUsd: undefined }), stalled).costUsd).toBeUndefined();
  });
});
