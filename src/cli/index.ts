import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Command, Option } from "commander";
import { Runtime } from "../app/runtime.js";
import { auditDirFor } from "../audit/logger.js";
import { BUILTIN_COMMANDS } from "../commands/builtins.js";
import { replaySession } from "../loop/replay.js";
import { DEFAULT_MAX_TOKENS } from "../loop/runAgent.js";
import {
  hasProviderKey,
  keepProviderKey,
  loadModelsConfig,
  type ResolvedModel,
  resolveModel,
} from "../model/providers.js";
import { AutoApprover } from "../permissions/autoApprover.js";
import { JOB_DENIAL } from "../permissions/engine.js";
import type { CallTarget } from "../permissions/types.js";
import { FileSessionStore, parseRecords } from "../session/store.js";
import { defaultTools } from "../tools/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { VERSION } from "../version.js";
import { loadSearchConfig } from "../web/search.js";
import { SwitchApprover, TerminalApprover } from "./approver.js";
import { banner, colorLevel } from "./banner.js";
import { describeError } from "./errors.js";
import { FOCUS_REPORTING_OFF, FocusTracker, reportsFocus } from "./focus.js";
import { JsonOutput, OUTPUT_FORMATS, type OutputFormat } from "./jsonOutput.js";
import { Notifier, pickChannel } from "./notify.js";
import { PlainRenderer, type Renderer } from "./renderer.js";
import { runRepl } from "./repl.js";
import { formatTokens, stopMessage } from "./report.js";
import { runTurnInTerminal, type TurnOutcome } from "./turn.js";

/**
 * Entry point (F1, F2):
 *   garuda                      chat in the current folder
 *   garuda -p "task"            run one task and exit (also: echo "task" | garuda)
 *   garuda -p "task" --output-format json|stream-json   the same, as JSON for scripts (0.5)
 *   garuda --resume [id]        continue a session (chat, or one task with -p)
 *   garuda --replay <id|file>   replay a session with no API calls
 *   garuda eval                 run the eval tasks (N5); --from-git builds the repo suite (0.12);
 *                               --network opens the allowlist for sandboxed commands (0.13)
 *   garuda lsp [install <lang>] language servers for diagnostics (0.4)
 *   garuda init                 set up this folder, then chat (0.5): same as /init
 *   garuda run <job> [--at HH:MM]  run a scheduled job, unattended (0.7)
 *   garuda night [--at HH:MM]   run the project's night queue, then write one digest (0.11)
 */

interface Options {
  prompt?: string;
  plan?: boolean;
  lsp?: boolean;
  model?: string;
  subagentModel?: string;
  resume?: string | true;
  replay?: string;
  /** A first chat line, as if typed: `garuda init` runs "/init". */
  firstInput?: string;
  outputFormat?: OutputFormat;
  verbose?: boolean;
  /** `garuda run <job>` (0.7): the job id, and the time to wait for. */
  job?: string;
  at?: string;
  /** The launchd agent started this run (0.7): remove the agent at the end. */
  fromLaunchd?: boolean;
}

async function main(): Promise<void> {
  const program = new Command()
    // Options after a subcommand belong to the subcommand: `garuda eval -m x` sets eval's model.
    .enablePositionalOptions()
    .name("garuda")
    .description("A terminal coding agent. With no task, it starts a chat in the current folder.")
    .version(VERSION)
    .option("-p, --prompt <task>", "run one task and exit")
    .option("-m, --model <id>", "model id (or set GARUDA_MODEL)")
    .option(
      "--subagent-model <id>",
      "model of the explore subagent (or set GARUDA_SUBAGENT_MODEL); default: the main model",
    )
    .option("--plan", "start in plan mode: read and plan, change nothing")
    .option("--lsp", "add language server errors to edit results (TS/JS, Python, Java)")
    .option("-r, --resume [session-id]", "continue the last session, or the given one")
    .option("--replay <session-id-or-file>", "replay a recorded session with no API calls")
    .addOption(
      new Option("--output-format <format>", "with a task: text (default), json or stream-json")
        .choices(OUTPUT_FORMATS)
        .default("text"),
    )
    .option("--verbose", "with json output: also show the tool activity on stderr")
    .action(async (options: Options) => {
      process.exitCode = await start(options, program);
    });

  program
    .command("eval")
    .description("run the eval tasks in scratch folders and report pass/fail, steps and cost")
    .option("-m, --model <id>", "model id (or set GARUDA_MODEL)")
    .option("-s, --suite <name>", "basic (default), hard, java, python, all or repo")
    .option("-t, --task <ids...>", "run only these tasks (from any suite)")
    .option("--max-steps <n>", "step limit per task", (v) => Number.parseInt(v, 10))
    .option("--repeat <n>", "run each task n times and show the mean", (v) =>
      Number.parseInt(v, 10),
    )
    .option("--index <mode>", "code index tools for the model: off (default), lookup or all")
    .option("--executor <name>", "auto (default), os or host")
    .option("--keep", "keep the scratch folders")
    .option("--list", "list the tasks and exit")
    .option("--subagents <mode>", "the explore subagent: off (default) or on, for A/B runs")
    .option("--subagent-model <id>", "model of the explore subagent; default: the main model")
    .option("--todo <mode>", "the todo_write tool: off (default) or on, for A/B runs")
    .option("--lsp <mode>", "language server errors in edit results: off (default) or on")
    .option(
      "--format <mode>",
      "the project's formatter after edits: off (default) or on, for A/B runs",
    )
    .option(
      "--keep-thinking <mode>",
      "send Claude's thinking blocks back: on (default) or off, for A/B runs",
    )
    .option(
      "--batch <mode>",
      "model calls through the Batch API (half price, slow): off (default) or on",
    )
    .option(
      "--parallel <n>",
      "tasks at the same time; default 1, with --batch on all (up to 20)",
      (v) => Number.parseInt(v, 10),
    )
    .option(
      "--prepare <toolchain>",
      "java: download Maven plugins and JUnit once; python: check pytest",
    )
    .option("--from-git", "build the repo suite from this project's recent commits, then exit")
    .option("--commits <n>", "with --from-git: recent commits to look at (default 200)", (v) =>
      Number.parseInt(v, 10),
    )
    .option("--since <date>", "with --from-git: only commits after this date")
    .option("--max-tasks <n>", "with --from-git: most tasks in the suite (default 30)", (v) =>
      Number.parseInt(v, 10),
    )
    .option(
      "--network <entries...>",
      "presets (npm, pypi, maven, go, cargo, github) or hosts that sandboxed commands may reach",
    )
    .option(
      "--test-command <cmd>",
      "with --from-git: the test command; {files} takes the test files (default: detected)",
    )
    .action(async (options) => {
      const { runEvalCommand } = await import("./evalCommand.js");
      process.exitCode = await runEvalCommand({
        ...options,
        model: options.model ?? process.env.GARUDA_MODEL,
        subagentModel: options.subagentModel ?? process.env.GARUDA_SUBAGENT_MODEL,
      });
    });

  program
    .command("init")
    .description(
      "set up this folder (AGENTS.md; commands, MCP servers and rules from Claude Code, OpenCode, Codex, Gemini CLI, Tabnine, Cursor, Copilot), then chat",
    )
    .option("-m, --model <id>", "model id (or set GARUDA_MODEL)")
    .action(async (options: { model?: string }) => {
      process.exitCode = await start({ ...options, firstInput: "/init" }, program);
    });

  program
    .command("run")
    .description(
      "run a scheduled job (made with /schedule) in its own worktree, with its approval list and nobody to ask",
    )
    .argument("<job-id>", "the job id, from /schedule or /jobs")
    .option("--at <HH:MM>", "wait until this local time first (keep the terminal open)")
    .option("-m, --model <id>", "model id; default: the job's model")
    .addOption(new Option("--from-launchd").hideHelp())
    .action(
      async (job: string, options: { at?: string; model?: string; fromLaunchd?: boolean }) => {
        process.exitCode = await start({ ...options, job }, program);
      },
    );

  program
    .command("night")
    .description(
      "run this project's night queue (jobs from /schedule), up to 3 at a time, then write one digest",
    )
    .option("--at <HH:MM>", "wait until this local time first (keep the terminal open)")
    .option("--parallel <n>", "jobs at the same time (1 to 10, default 3)")
    .addOption(new Option("--from-launchd").hideHelp())
    .action(async (options: { at?: string; parallel?: string; fromLaunchd?: boolean }) => {
      const { nightCommand } = await import("./nightCommand.js");
      process.exitCode = await nightCommand(options, new PlainRenderer());
    });

  const lsp = program
    .command("lsp")
    .description("show the language servers for diagnostics (TS/JS, Python, Java)")
    .action(async () => {
      const { lspStatusCommand } = await import("./lspCommand.js");
      process.exitCode = await lspStatusCommand();
    });
  lsp
    .command("install")
    .description("install a pinned language server into ~/.garuda/lsp (needs the network)")
    .argument("<language>", "typescript, python or java")
    .action(async (language: string) => {
      const { lspInstallCommand } = await import("./lspCommand.js");
      process.exitCode = await lspInstallCommand(language);
    });

  await program.parseAsync();
}

async function start(options: Options, program: Command): Promise<number> {
  const mainRoot = realpathSync(process.cwd());
  const store = new FileSessionStore(mainRoot);
  if (options.replay !== undefined) return replay(options.replay, store);

  // A scheduled job (0.7): the runtime works in the job's worktree; the session stays in this project.
  let job: import("./jobCommand.js").PreparedJob | undefined;
  if (options.job !== undefined) {
    const { prepareJob } = await import("./jobCommand.js");
    const prepared = await prepareJob(
      mainRoot,
      options.job,
      options.at,
      new PlainRenderer(),
      undefined,
      { fromLaunchd: options.fromLaunchd === true },
      homedir(),
    );
    if (typeof prepared === "number") return prepared;
    job = prepared;
  }
  const root = job?.root ?? mainRoot;

  // A task on stdin works like -p: echo "task" | garuda
  let prompt = job?.job.prompt ?? options.prompt;
  if (prompt === undefined && !process.stdin.isTTY && job === undefined)
    prompt = readFileSync(0, "utf8").trim();
  if (prompt === "") program.error("The task is empty.");
  const format = options.outputFormat ?? "text";
  if (format !== "text" && prompt === undefined) {
    program.error(`--output-format ${format} needs a task: use -p "task" or give it on stdin.`);
  }

  const spec = options.model ?? job?.job.model ?? process.env.GARUDA_MODEL;
  if (!spec) program.error("Set a model with --model <id> or the GARUDA_MODEL variable.");
  // Providers come only from the user's own ~/.garuda/models.json (never from the project).
  const models = await loadModelsConfig();
  if (models.problem !== undefined) program.error(models.problem);
  let resolved: ResolvedModel;
  try {
    resolved = resolveModel(spec as string, models.config);
  } catch (error) {
    program.error((error as Error).message);
  }
  const modelId = resolved.spec;
  const subSpec = options.subagentModel ?? process.env.GARUDA_SUBAGENT_MODEL;
  let sub: ResolvedModel | undefined;
  if (subSpec) {
    try {
      sub = resolveModel(subSpec, models.config);
    } catch (error) {
      program.error((error as Error).message);
    }
  }

  // Web search (0.5): only the user's ~/.garuda/search.json and environment configure it. It reads
  // its keys now, before the model keys are taken out of the environment below.
  const searchConfig = await loadSearchConfig();

  // Take the model-provider keys out of Garuda's own environment (0.14, review): a command in the
  // OS sandbox could otherwise read them from /proc/<pid>/environ of the Garuda process. create()
  // reads them from the kept store instead. Done after the models and search config are loaded.
  const hasApiKey = hasProviderKey("ANTHROPIC_API_KEY");
  for (const name of [resolved.def.apiKeyEnv, sub?.def.apiKeyEnv, "ANTHROPIC_API_KEY"]) {
    if (name !== undefined) keepProviderKey(name);
  }

  // Team policy: the managed file and ~/.garuda/policy.json, never the project (merge gate). The
  // chat, -p, `garuda run` (a job) and the night shift (a `garuda run` per job) all start here.
  const { loadTeamPolicy } = await import("../permissions/policy.js");
  let team: Awaited<ReturnType<typeof loadTeamPolicy>>;
  try {
    team = await loadTeamPolicy();
  } catch (error) {
    program.error(`Team policy: ${(error as Error).message}`);
  }

  const renderer = new PlainRenderer();
  const terminalApprover = new TerminalApprover();
  // A job has nobody to ask: every question (consents, approvals) gets "no".
  const approver = new SwitchApprover(
    job === undefined ? terminalApprover : new AutoApprover("deny"),
  );
  // Agent events go to the plain renderer, or to the Ink chat once it starts.
  let events: Renderer = renderer;
  const runtime = await Runtime.create({
    root,
    modelId,
    ...(team === undefined ? {} : { policy: team.policy, policySources: team.sources }),
    // The audit log lives in ~/.garuda/audit, keyed by the project (a job: its main checkout, not
    // the worktree that is deleted after the job).
    audit: { dir: auditDirFor(job?.job.root ?? root) },
    model:
      job?.job.batch === true && resolved.createBatch !== undefined
        ? () => jobBatchClient(job as NonNullable<typeof job>, resolved, renderer)
        : () => resolved.create(),
    modelInfo: resolved.info,
    ...(resolved.maxTokens === undefined ? {} : { maxTokens: resolved.maxTokens }),
    ...(sub === undefined
      ? {}
      : { subagentModel: { spec: sub.spec, model: () => sub.create(), info: sub.info } }),
    approver,
    store,
    ...(job === undefined
      ? {}
      : {
          settings: job.settings,
          // The job's network list was approved with the job (0.13).
          network: { approved: true },
          unattended: {
            reason: JOB_DENIAL,
            onDeny: (tool: string, target: CallTarget) => recordJobDenial(job, tool, target),
          },
        }),
    ...(options.plan === true ? { mode: "plan" as const } : {}),
    ...(options.lsp === true ? { lsp: { enabled: true } } : {}),
    // Undo snapshots are on for the chat and for -p (a later chat can undo the task). A job has its
    // own branch instead.
    ...(job === undefined ? { undo: {} } : {}),
    // Skills from ~/.garuda/skills, ~/.claude/skills and the project (0.5).
    skills: {},
    // User language plugins from ~/.garuda/languages (0.16); project plugins stay off.
    languages: {},
    // The project's settings that loosen safety: asked at startup when there is a terminal,
    // pinned in ~/.garuda/trust.json (a job passes its own settings).
    projectSettings: { home: homedir(), ask: process.stdin.isTTY === true },
    // Web search (0.5) and Claude's own search (0.6): only the user's search.json and environment.
    ...(searchConfig.config === undefined && searchConfig.claude === undefined
      ? {}
      : {
          search: {
            ...(searchConfig.config === undefined ? {} : { config: searchConfig.config }),
            ...(searchConfig.claude === undefined ? {} : { claude: searchConfig.claude }),
            // The saved choice (0.14); the first-time answer is saved in ~/.garuda/search.json.
            ...(searchConfig.use === undefined ? {} : { use: searchConfig.use }),
            home: homedir(),
          },
        }),
    // Custom agents from ~/.garuda/agents, ~/.claude/agents and the project (0.5). A model id in a
    // user agent file goes through the same providers as -m (only ~/.garuda/models.json).
    agents: {
      resolveModel: (spec: string) => {
        const r = resolveModel(spec, models.config);
        return { spec: r.spec, model: () => r.create(), info: r.info };
      },
    },
    // /models (0.6): the same providers as -m; the list adds the user's configured models.
    models: {
      resolve: (spec: string) => {
        const r = resolveModel(spec, models.config);
        return {
          spec: r.spec,
          model: () => r.create(),
          info: r.info,
          ...(r.maxTokens === undefined ? {} : { maxTokens: r.maxTokens }),
        };
      },
      configured: Object.keys(models.config.models),
    },
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    onEvent: (event) => events.event(event),
    onNotice: (text) => events.warn(text),
  });

  // No orphan process stays (F4): kill running commands on any exit.
  process.on("exit", () => runtime.executor.shutdown());
  const exitNow = (): never => {
    runtime.executor.shutdown();
    process.exit(130);
  };

  if (runtime.executorNotice !== undefined) renderer.warn(runtime.executorNotice);
  if (job !== undefined && runtime.executor.isolation === "none") {
    renderer.error(
      "A job needs the OS sandbox (Seatbelt or bubblewrap): without it, every command would need an approval, and nobody is there to give it.",
    );
    await runtime.close();
    const { saveJob } = await import("../jobs/job.js");
    job.job.status = "failed";
    await saveJob(job.job);
    if (options.fromLaunchd === true || job.job.launchd !== undefined) {
      const { removeAgent, defaultAgentEnv } = await import("../jobs/launchd.js");
      await removeAgent(runtime.executor, job.job, defaultAgentEnv());
    }
    return 1;
  }
  if (searchConfig.problem !== undefined) {
    renderer.warn(
      searchConfig.claude === undefined
        ? `Web search is off: ${searchConfig.problem}`
        : `The fallback web search is off (Claude's search still works): ${searchConfig.problem}`,
    );
  }
  const session = runtime.session;
  if (session !== undefined) {
    renderer.info(
      `Resumed session ${session.id} (${session.messages.length} messages, ${formatTokens(session.contextTokens)} tokens of context).`,
    );
  }
  for (const note of resolved.notes) renderer.info(note);
  if (runtime.price === undefined) {
    renderer.warn(
      `Garuda has no price for ${modelId}. Set "price" for it in ~/.garuda/models.json to see cost.`,
    );
  }

  if (prompt !== undefined) {
    const output =
      format === "text"
        ? undefined
        : new JsonOutput({
            format,
            write: (line) => process.stdout.write(`${line}\n`),
            // stdout holds only JSON: model text never goes there.
            log: new PlainRenderer({ out: nullStream(), err: process.stderr }),
            verbose: options.verbose === true,
            sessionId: () => runtime.session?.id ?? "",
            runInfo: () => ({
              cwd: root,
              model: modelId,
              tools: runtime.toolNames(),
              mcpServers: runtime.mcpStatus(),
              permissionMode: runtime.mode === "plan" ? "plan" : "default",
              slashCommands: [
                ...BUILTIN_COMMANDS,
                ...runtime.commands.map((c) => c.name),
                ...runtime.skills.filter((k) => k.userInvocable).map((k) => k.name),
              ],
              skills: runtime.skills.map((k) => k.name),
              agents: runtime.agents.map((a) => a.name),
              apiKeySource: !modelId.includes("/") && hasApiKey ? "ANTHROPIC_API_KEY" : "none",
            }),
          });
    if (output !== undefined) events = output;
    const costBefore = runtime.session?.costUsd ?? 0;
    const finish = (outcome: TurnOutcome) => {
      const cost = runtime.session?.costUsd;
      output?.finish(outcome, {
        totalCostUsd: cost ?? 0,
        runCostUsd: cost === undefined ? undefined : cost - costBefore,
        contextWindow: runtime.limits.contextWindow,
        maxOutputTokens: resolved.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(outcome.kind === "done"
          ? { stopMessage: stopMessage(outcome.result.stopReason, runtime.limits) }
          : {}),
      });
    };
    // `garuda -p "/review src"` runs a custom command; other text goes to the model as it is.
    if (prompt.startsWith("/")) {
      const resolved = await runtime.resolveCommand(prompt, new AbortController().signal);
      if (resolved.kind === "denied") {
        (output ?? renderer).warn(resolved.message);
        await runtime.close();
        finish({ kind: "error", message: resolved.message });
        return 1;
      }
      if (resolved.kind === "prompt") prompt = resolved.prompt;
    }
    // Proof of work (0.11): the job's tests at its base, before the turn.
    if (job !== undefined) {
      const { testsBefore } = await import("./jobCommand.js");
      await testsBefore(job, runtime, renderer);
    }
    const outcome = await runTurnInTerminal(
      runtime,
      terminalApprover,
      output ?? renderer,
      prompt,
      exitNow,
    );
    await runtime.close();
    finish(outcome);
    if (job !== undefined) {
      const { finishJob } = await import("./jobCommand.js");
      await finishJob(job, outcome, runtime, renderer, undefined, {
        fromLaunchd: options.fromLaunchd === true,
      });
    }
    if (outcome.kind === "interrupted") return 130;
    if (outcome.kind === "error") return 1;
    return outcome.result.stopReason === "done" ? 0 : 2;
  }

  const ink = wantsInk() ? await loadInk(renderer) : undefined;
  const bannerInfo = {
    version: VERSION,
    model: modelId,
    sandbox:
      runtime.executor.isolation === "none"
        ? "none: each command asks first"
        : `${runtime.executor.name} · no network`,
    root,
    extras: runtime.extras(),
    subagents: runtime.subagentsSummary(),
    agents: runtime.agentsSummary(),
    skills: runtime.skillsSummary(),
    tools: runtime.toolsSummary(),
    ink: ink !== undefined,
  };
  let startBanner = banner(bannerInfo, {
    columns: process.stdout.columns || 80,
    color: colorLevel(process.stdout),
  });
  if (options.firstInput === undefined) {
    const { initTip } = await import("../init/detect.js");
    const tip = initTip(root);
    if (tip !== undefined) startBanner += `\n${tip}`;
  }
  const sessionPath = (id: string) => join(store.dir, `${id}.jsonl`);
  // Notifications (0.6): only for a chat on a terminal; escape codes go to the terminal itself.
  const notify = runtime.notificationSettings;
  const channel = pickChannel(notify?.channel);
  // Focus reporting: in the Ink chat, nothing goes out while the user looks at Garuda's window.
  const focus =
    ink !== undefined && channel !== "off" && reportsFocus() ? new FocusTracker() : undefined;
  if (focus !== undefined) process.on("exit", () => process.stdout.write(FOCUS_REPORTING_OFF));
  const notifier = process.stdout.isTTY
    ? new Notifier(
        channel,
        (bytes) => process.stdout.write(bytes),
        notify?.afterSeconds,
        () => focus?.focused,
      )
    : undefined;
  if (notifier !== undefined) approver.onAsk = (request) => notifier.approval(request);
  if (ink !== undefined) {
    const setEventTarget = (target: Renderer) => {
      events = target;
    };
    await ink.runInkChat(
      runtime,
      approver,
      setEventTarget,
      startBanner,
      sessionPath,
      exitNow,
      options.firstInput,
      notifier,
      focus,
    );
  } else {
    process.stderr.write(`${startBanner}\n`);
    await runRepl(
      runtime,
      terminalApprover,
      renderer,
      sessionPath,
      exitNow,
      undefined,
      options.firstInput,
      notifier,
    );
  }
  await runtime.close();
  const id = runtime.session?.id;
  if (id !== undefined) renderer.info(`Session ${id}. Continue it with: garuda --resume ${id}`);
  return 0;
}

/** A stream that drops what it gets. */
function nullStream(): Writable {
  return new Writable({ write: (_chunk, _encoding, done) => done() });
}

/** The Ink chat needs a terminal on both sides. GARUDA_PLAIN=1 turns it off. */
function wantsInk(): boolean {
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    process.env.GARUDA_PLAIN !== "1" &&
    process.env.TERM !== "dumb"
  );
}

/** Ink loads on demand (N3). The standalone binary has no Ink: it uses the plain chat. */
async function loadInk(
  renderer: PlainRenderer,
): Promise<typeof import("./chat/inkChat.js") | undefined> {
  try {
    return await import("./chat/inkChat.js");
  } catch (error) {
    renderer.info(`Plain chat (Ink is not available: ${(error as Error).message.split("\n")[0]}).`);
    return undefined;
  }
}

/** --replay: play a session back with a fake model and recorded tool results (F26). */
async function replay(target: string, store: FileSessionStore): Promise<number> {
  const records = existsSync(target)
    ? parseRecords(readFileSync(target, "utf8"))
    : await store.read(target);
  const report = await replaySession(records, new ToolRegistry(defaultTools({ daemons: true })));
  const summary = `${report.runs} run(s), ${report.steps} step(s), ${report.toolCalls} tool call(s)`;
  if (report.matches) {
    process.stdout.write(`Replay matches the recording: ${summary}.\n`);
    return 0;
  }
  process.stdout.write(`Replay does not match the recording (${summary}):\n`);
  for (const problem of report.problems) process.stdout.write(`  - ${problem}\n`);
  return 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`Error: ${describeError(error)}\n`);
  process.exitCode = 1;
});

/** The engine's record of a call that a job denied (0.7), for the report. */
function recordJobDenial(
  job: import("./jobCommand.js").PreparedJob,
  tool: string,
  target: CallTarget,
): void {
  const shown =
    target.kind === "path"
      ? target.path
      : target.kind === "command"
        ? (target.command.split("\n")[0] ?? "")
        : target.kind === "url"
          ? target.host
          : target.json.slice(0, 200);
  job.denied.push({ tool, target: shown });
}

/**
 * A job on the Batch API (0.7): the batch client until 15 minutes before the finish-by time, then the
 * normal API. The client is kept on the job, so the report can count the requests of each.
 */
async function jobBatchClient(
  job: import("./jobCommand.js").PreparedJob,
  resolved: ResolvedModel,
  renderer: Renderer,
): Promise<import("../model/types.js").ModelClient> {
  const { DeadlineClient } = await import("../model/deadline.js");
  const { nextTime } = await import("../jobs/launchd.js");
  const { DEFAULT_FINISH_BY, DEFAULT_STEP_LIMIT_MINUTES, SWITCH_BEFORE_MS } = await import(
    "../jobs/create.js"
  );
  const finishBy = job.job.finishBy ?? DEFAULT_FINISH_BY;
  const stepLimit = job.job.stepLimitMinutes ?? DEFAULT_STEP_LIMIT_MINUTES;
  const switchAt = new Date(nextTime(finishBy).getTime() - SWITCH_BEFORE_MS);
  const batch = await (resolved.createBatch as NonNullable<ResolvedModel["createBatch"]>)(
    process.env,
    {
      // A quiet terminal must not look stuck: the batch id, then a line every minute.
      onWait: ({ batchId, waitedMs, status }) =>
        renderer.info(
          waitedMs === 0
            ? `Waiting for batch ${batchId} …`
            : `  still waiting for ${batchId}: ${Math.round(waitedMs / 60_000)} min (${status})`,
        ),
    },
  );
  job.deadline = new DeadlineClient(batch, () => resolved.create(), switchAt, {
    stepLimitMs: stepLimit * 60_000,
  });
  const when = switchAt.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  renderer.info(
    `Batch API (half price) until ${when}, then the normal API. A step that waits more than ${stepLimit} min runs on the normal API.`,
  );
  return job.deadline;
}
