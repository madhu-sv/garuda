import { z } from "zod";
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

    try {
      const info: CallInfo | undefined = tool.describe
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
      if (blocked !== undefined) return { content: `Blocked by a hook: ${blocked}`, isError: true };
      const decision = await context.permissions.check(
        info === undefined
          ? { tool: tool.name, readOnly: tool.readOnly }
          : { tool: tool.name, readOnly: tool.readOnly, info },
        context.signal,
      );
      if (!decision.allowed) {
        return { content: `Permission denied: ${decision.reason}`, isError: true, denied: true };
      }
      const startTime = Date.now();
      const output: unknown = await tool.run(parsed.data, context);
      const durationMs = Date.now() - startTime;
      const content = tool.toText ? tool.toText(output) : String(output);
      const outcome = { content, isError: tool.isError?.(output) === true };
      if (context.audit !== undefined) {
        await context.audit.logToolExecution({
          tool: tool.name,
          ...(info?.target === undefined ? {} : { target: info.target }),
          durationMs,
          isError: outcome.isError,
        });
      }
      const final =
        context.hooks === undefined
          ? outcome
          : await context.hooks.after(hookCall, outcome, context.signal);
      // The usage report does not depend on hooks: the child run has happened either way.
      const subagent = tool.report?.(output);
      return subagent === undefined ? final : { ...final, subagent };
    } catch (error) {
      if (context.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (context.audit !== undefined) {
        await context.audit.logToolExecution({
          tool: call.name,
          durationMs: 0,
          isError: true,
        });
      }
      return { content: `Error: ${call.name} failed: ${message}`, isError: true };
    }
  }
}
