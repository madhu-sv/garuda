import { z } from "zod";
import { AuditWriteError } from "../audit/logger.js";
import type { ToolSpec, ToolUseBlock } from "../model/types.js";
import type { CallInfo } from "../permissions/types.js";
import type { AnyTool, ToolContext, ToolOutcome, ToolRunner } from "./types.js";

export class ToolRegistry implements ToolRunner {
  private readonly tools = new Map<string, AnyTool>();

  constructor(tools: readonly AnyTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: AnyTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered.`);
    this.tools.set(tool.name, tool);
  }

  /** Remove a tool (0.14: `/search off` takes web_search away for the session). */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  /** For the loop's batches: read-only calls run in parallel, unless the tool runs alone. */
  isReadOnly(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.readOnly === true && tool.runsAlone !== true;
  }

  runsCommands(name: string): boolean {
    return this.tools.get(name)?.runsCommands === true;
  }

  /**
   * Tool definitions for the model, sorted by name.
   * A stable order keeps the prompt cache valid across turns (N2).
   */
  specs(): ToolSpec[] {
    return [...this.tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema:
          tool.jsonSchema ??
          (z.toJSONSchema(tool.inputSchema, { io: "input" }) as Record<string, unknown>),
      }));
  }

  /**
   * Run one tool call. This never throws: every failure becomes an error result
   * that the model can read and correct (F16).
   * The permission check runs after validation and before `run` (F17–F20).
   */
  async execute(call: ToolUseBlock, context: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.get(call.name);
    if (tool === undefined) {
      return { content: `Error: unknown tool "${call.name}".`, isError: true };
    }

    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      return {
        content: `Error: invalid input for ${call.name}.\n${z.prettifyError(parsed.error)}`,
        isError: true,
      };
    }

    let info: CallInfo | undefined;
    let startTime: number | undefined;
    let logged = false;
    // One execution event per call that ran (0.14, review: a late failure logged a second one).
    const logRun = async (isError: boolean) => {
      if (logged || context.audit === undefined) return;
      logged = true;
      await context.audit.logToolExecution({
        tool: tool.name,
        ...(info?.target === undefined ? {} : { target: info.target }),
        durationMs: startTime === undefined ? 0 : Date.now() - startTime,
        isError,
      });
    };
    let ran: ToolOutcome | undefined;
    try {
      info = tool.describe
        ? await tool.describe(parsed.data, context)
        : tool.readOnly
          ? undefined
          : { target: { kind: "input", json: JSON.stringify(parsed.data) } };
      const hookCall = {
        tool: tool.name,
        input: parsed.data,
        ...(info === undefined ? {} : { info }),
      };
      const blocked = await context.hooks?.before(hookCall, context.signal);
      if (blocked !== undefined) {
        await context.audit?.logHookBlock({
          tool: tool.name,
          ...(info?.target === undefined ? {} : { target: info.target }),
          reason: blocked,
        });
        return { content: `Blocked by a hook: ${blocked}`, isError: true };
      }
      // A read-only tool can mark one call as a change (CallInfo.mutates).
      const readOnly = tool.readOnly && info?.mutates !== true;
      const decision = await context.permissions.check(
        info === undefined ? { tool: tool.name, readOnly } : { tool: tool.name, readOnly, info },
        context.signal,
      );
      if (!decision.allowed) {
        return { content: `Permission denied: ${decision.reason}`, isError: true, denied: true };
      }
      startTime = Date.now();
      // Partial approval (U0): the tool must apply only the accepted hunks.
      const runContext =
        decision.hunks === undefined
          ? context
          : {
              ...context,
              approvedHunks: decision.hunks,
              ...(info?.preview === undefined ? {} : { approvedPreview: info.preview }),
            };
      const output: unknown = await tool.run(parsed.data, runContext);
      const content = tool.toText ? tool.toText(output) : String(output);
      const outcome = { content, isError: tool.isError?.(output) === true };
      ran = outcome;
      await logRun(outcome.isError);
      const final =
        context.hooks === undefined
          ? outcome
          : await context.hooks.after(hookCall, outcome, context.signal);
      // The usage report does not depend on hooks: the child run has happened either way.
      const subagent = tool.report?.(output);
      return subagent === undefined ? final : { ...final, subagent };
    } catch (error) {
      if (context.signal.aborted) throw error;
      // The team policy requires the audit log and it cannot be written (0.14, review): the call
      // fails closed with an error result. Before, execute threw, the turn died, and a tool that
      // had already run was neither recorded nor reported to the model.
      if (error instanceof AuditWriteError) {
        return {
          content:
            ran === undefined
              ? `Error: ${error.message}. The team policy requires the audit log, so the call did not run.`
              : `${ran.content}\n\nError: ${error.message}. The call ran, but it is not in the audit log that the team policy requires.`,
          isError: true,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      try {
        if (startTime !== undefined) await logRun(true);
      } catch (auditError) {
        if (!(auditError instanceof AuditWriteError)) throw auditError;
        return {
          content: `Error: ${call.name} failed: ${message}\n\nError: ${auditError.message}.`,
          isError: true,
        };
      }
      return { content: `Error: ${call.name} failed: ${message}`, isError: true };
    }
  }
}
