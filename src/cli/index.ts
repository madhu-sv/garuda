import { Command } from "commander";
import { runAgent } from "../loop/runAgent.js";
import { AnthropicClient } from "../model/anthropic.js";
import { addUserMessage, createSession } from "../session/session.js";
import { ToolRegistry } from "../tools/registry.js";

/**
 * M1 entry point: one-shot mode only, no tools yet.
 * M5 adds interactive mode, Ctrl-C handling and the full renderer (F1–F4).
 */

const SYSTEM_PROMPT = [
  "You are a coding agent in a terminal.",
  "You work inside one project folder: the working root.",
  "Be brief. Explain what you change and why.",
].join("\n");

async function main(): Promise<void> {
  const program = new Command()
    .name("garuda")
    .description("A terminal coding agent.")
    .version("0.1.0-m1")
    .requiredOption("-p, --prompt <task>", "run one task and exit")
    .option("-m, --model <id>", "model id (or set GARUDA_MODEL)")
    .parse();

  const options = program.opts<{ prompt: string; model?: string }>();
  const model = options.model ?? process.env.GARUDA_MODEL;
  if (!model) {
    program.error("Set a model with --model <id> or the GARUDA_MODEL variable.");
    return;
  }

  const session = createSession(process.cwd());
  addUserMessage(session, options.prompt);

  const result = await runAgent(session, {
    model: new AnthropicClient({ model }),
    tools: new ToolRegistry(),
    system: SYSTEM_PROMPT,
    onEvent: (event) => {
      if (event.type === "text_delta") process.stdout.write(event.text);
    },
  });

  const { inputTokens, outputTokens } = result.usage;
  process.stderr.write(
    `\n[${result.stopReason} · ${result.steps} step(s) · ${inputTokens} in / ${outputTokens} out tokens]\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
