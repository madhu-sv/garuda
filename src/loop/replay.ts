import { isDeepStrictEqual } from "node:util";
import { FakeModelClient } from "../model/fake.js";
import type { ModelResponse, ToolSpec, ToolUseBlock } from "../model/types.js";
import type { PermissionGate } from "../permissions/types.js";
import type { SessionRecord, StartRecord } from "../session/records.js";
import { rebuildState } from "../session/resume.js";
import { addUserMessage, closeOpenToolCalls, createSession } from "../session/session.js";
import type { ToolContext, ToolOutcome, ToolRunner } from "../tools/types.js";
import { runAgent, signature } from "./runAgent.js";

/**
 * Replay (F26): run the loop again on a recorded session, with no API calls and no side effects.
 * A fake model plays the recorded responses. Tool results come from the record too.
 * The replay matches when the loop makes the same tool calls, stops for the same reasons,
 * and builds the same conversation, run by run.
 */

export interface ReplayReport {
  matches: boolean;
  runs: number;
  steps: number;
  toolCalls: number;
  problems: string[];
}

export async function replaySession(
  records: readonly SessionRecord[],
  /** The real tools: replay uses their definitions and read-only flags, never their code. */
  tools: ToolRunner,
): Promise<ReplayReport> {
  const problems: string[] = [];
  const responses: ModelResponse[] = [];
  const outcomes = new Map<string, ToolOutcome>();
  const expectedCalls: string[] = [];
  for (const record of records) {
    if (record.type === "assistant") {
      responses.push(record.response);
      for (const block of record.response.content) {
        if (block.type === "tool_use") expectedCalls.push(signature(block));
      }
    }
    if (record.type === "compaction" && record.summary !== undefined)
      responses.push(record.summary);
    if (record.type === "tool_results" && record.synthetic !== true) {
      for (const block of record.message.content) {
        if (block.type === "tool_result") {
          outcomes.set(block.toolUseId, { content: block.content, isError: block.isError });
        }
      }
    }
  }

  const model = new FakeModelClient(responses);
  const recorded = new RecordedTools(tools, outcomes, problems);
  const first = records.find((r): r is StartRecord => r.type === "start");
  const session = createSession(first?.root ?? "/replay", first?.sessionId ?? "replay");

  let limits = first?.limits;
  let runs = 0;
  let steps = 0;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === undefined) break;
    if (record.type === "start" || record.type === "resume") limits = record.limits;
    if (record.type !== "user") continue;

    const endIndex = records.findIndex((r, j) => j > i && (r.type === "end" || r.type === "user"));
    const end = endIndex === -1 ? undefined : records[endIndex];
    if (end?.type !== "end" || end.stopReason === "interrupted" || end.stopReason === "error") {
      problems.push(
        `Run ${runs + 1} did not finish in the recording (it was interrupted). Replay stops there.`,
      );
      break;
    }

    runs++;
    closeOpenToolCalls(session);
    const text = record.message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    addUserMessage(session, text);
    const result = await runAgent(session, {
      model,
      tools: recorded,
      system: "replay",
      permissions: NO_PERMISSIONS,
      ...(limits === undefined
        ? {}
        : {
            maxSteps: limits.maxSteps,
            tokenBudget: limits.tokenBudget,
            contextWindow: limits.contextWindow,
          }),
    });
    steps += result.steps;

    if (result.stopReason !== end.stopReason || result.steps !== end.steps) {
      problems.push(
        `Run ${runs}: the recording stopped with ${end.stopReason} after ${end.steps} steps; the replay stopped with ${result.stopReason} after ${result.steps} steps.`,
      );
    }
    const expected = rebuildState(records.slice(0, endIndex + 1)).messages;
    if (!isDeepStrictEqual(session.messages, expected)) {
      problems.push(`Run ${runs}: the conversation differs from the recording.`);
    }
  }

  if (model.remaining > 0)
    problems.push(`${model.remaining} recorded model responses were not used.`);
  const actualCalls = recorded.calls;
  if (
    problems.length === 0 &&
    !isDeepStrictEqual(actualCalls, expectedCalls.slice(0, actualCalls.length))
  ) {
    problems.push("The tool calls differ from the recording.");
  }
  return { matches: problems.length === 0, runs, steps, toolCalls: actualCalls.length, problems };
}

/** Tools that answer from the record. */
class RecordedTools implements ToolRunner {
  readonly calls: string[] = [];

  constructor(
    private readonly real: ToolRunner,
    private readonly outcomes: ReadonlyMap<string, ToolOutcome>,
    private readonly problems: string[],
  ) {}

  specs(): ToolSpec[] {
    return this.real.specs();
  }

  isReadOnly(name: string): boolean {
    return this.real.isReadOnly(name);
  }

  runsCommands(name: string): boolean {
    return this.real.runsCommands(name);
  }

  async execute(call: ToolUseBlock, _context: ToolContext): Promise<ToolOutcome> {
    this.calls.push(signature(call));
    const outcome = this.outcomes.get(call.id);
    if (outcome !== undefined) return outcome;
    this.problems.push(`No recorded result for ${call.name} call ${call.id}.`);
    return { content: "Error: no recorded result.", isError: true };
  }
}

/** Replay never asks for permission: recorded tools do not run. */
const NO_PERMISSIONS: PermissionGate = {
  check: async () => ({ allowed: false, by: "rule", reason: "Replay runs no tools." }),
  execPolicy: () => {
    throw new Error("Replay runs no commands.");
  },
};
