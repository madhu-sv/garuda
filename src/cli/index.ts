import { realpathSync } from "node:fs";
import { Command } from "commander";
import { runAgent } from "../loop/runAgent.js";
import { AnthropicClient } from "../model/anthropic.js";
import { PermissionEngine } from "../permissions/engine.js";
import { loadSettings } from "../permissions/settings.js";
import { createExecutor } from "../sandbox/index.js";
import { addUserMessage, createSession } from "../session/session.js";
import { defaultTools } from "../tools/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { VERSION } from "../version.js";
import { TerminalApprover } from "./approver.js";
import { describeError, greeting } from "./greeting.js";

/**
 * Entry point: a greeting with no task, one-shot mode with -p.
 * Read-only tools run freely. write_file, edit_file and bash ask for approval (M3).
 * M5 adds interactive mode, Ctrl-C handling and the full renderer (F1–F4).
 */

function systemPrompt(root: string): string {
  return [
    "You are Garuda, a coding agent in a terminal.",
    `You work inside one project folder, the working root: ${root}`,
    "Use the tools to look at the code before you answer. Do not guess file contents.",
    "Use glob to find files by name, grep to search contents, and read_file to read a file.",
    "Use edit_file to change a file and write_file to create one. Read a file before you edit it.",
    "Use bash to run commands, for example tests and builds. The user approves each change and command.",
    "If the user denies a call, do not retry it. Ask what to do instead.",
    "Paths are relative to the working root.",
    "Be brief. Cite file paths and line numbers when you point to code.",
  ].join("\n");
}

async function main(): Promise<void> {
  const program = new Command()
    .name("garuda")
    .description("A terminal coding agent.")
    .version(VERSION)
    .option("-p, --prompt <task>", "run one task and exit")
    .option("-m, --model <id>", "model id (or set GARUDA_MODEL)")
    .parse();

  const options = program.opts<{ prompt?: string; model?: string }>();
  if (options.prompt === undefined) {
    process.stdout.write(greeting());
    return;
  }

  const model = options.model ?? process.env.GARUDA_MODEL;
  if (!model) {
    program.error("Set a model with --model <id> or the GARUDA_MODEL variable.");
    return;
  }

  const root = realpathSync(process.cwd());
  const settings = await loadSettings(root);
  const executor = createExecutor(settings.executor);
  const permissions = new PermissionEngine({
    root,
    settings,
    approver: new TerminalApprover(),
    isolation: executor.isolation,
  });
  const session = createSession(root);
  addUserMessage(session, options.prompt);

  const result = await runAgent(session, {
    model: new AnthropicClient({ model }),
    tools: new ToolRegistry(defaultTools()),
    system: systemPrompt(root),
    permissions,
    executor,
    onEvent: (event) => {
      if (event.type === "text_delta") process.stdout.write(event.text);
      if (event.type === "tool_call") {
        process.stderr.write(`\n→ ${event.call.name} ${JSON.stringify(event.call.input)}\n`);
      }
      if (event.type === "tool_result" && event.outcome.isError) {
        process.stderr.write(`  ✗ ${event.outcome.content.split("\n")[0]}\n`);
      }
    },
  });

  const { inputTokens, outputTokens } = result.usage;
  process.stderr.write(
    `\n[${result.stopReason} · ${result.steps} step(s) · ${inputTokens} in / ${outputTokens} out tokens]\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`Error: ${describeError(error)}\n`);
  process.exitCode = 1;
});
