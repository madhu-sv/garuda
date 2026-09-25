import { homedir } from "node:os";
import { join } from "node:path";
import { createExploreTool, DEFAULT_EXPLORE_LIMITS } from "../agents/explore.js";
import { BUILTIN_COMMANDS } from "../commands/builtins.js";
import {
  type CustomCommand,
  commandConsent,
  expandCommand,
  loadCommands,
  parseCommandLine,
} from "../commands/custom.js";
import { buildSystemPrompt, loadInstructions, loadMemory } from "../context/instructions.js";
import { HOOKS_FILE, type Hook, hooksHash, loadHooks } from "../hooks/config.js";
import { HookRunner, hooksConsent } from "../hooks/runner.js";
import { KnowledgeIndex } from "../knowledge/index.js";
import { type CodeIndexMode, DEFAULT_CODE_INDEX_MODE } from "../knowledge/mode.js";
import {
  detectProfiles,
  type LanguageProfile,
  profileAccess,
  profileNotes,
} from "../lang/profiles.js";
import {
  type AgentEvent,
  type AgentResult,
  DEFAULT_MAX_STEPS,
  DEFAULT_TOKEN_BUDGET,
  runAgent,
} from "../loop/runAgent.js";
import { loadMcpConfig, type ServerConfig } from "../mcp/config.js";
import type { McpManager, McpServerStatus } from "../mcp/manager.js";
import { TrustStore } from "../mcp/trust.js";
import { lookupModel, type ModelInfo, type Price } from "../model/pricing.js";
import type { ModelClient } from "../model/types.js";
import { PermissionEngine } from "../permissions/engine.js";
import { loadSettings, type Settings } from "../permissions/settings.js";
import type { Approver } from "../permissions/types.js";
import { createExecutor, type ExecutorChoice } from "../sandbox/index.js";
import type { Executor } from "../sandbox/types.js";
import type { RunLimits, StartRecord } from "../session/records.js";
import { resumeSession } from "../session/resume.js";
import { addUserMessage, createSession, type Session } from "../session/session.js";
import { newSessionId, type SessionStore } from "../session/store.js";
import { defaultTools, readOnlyTools } from "../tools/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { VERSION } from "../version.js";

/** What a line that starts with "/" means, when it is not a built-in command. */
export type CommandResolution =
  | { kind: "none" }
  | { kind: "prompt"; prompt: string; command: CustomCommand }
  | { kind: "denied"; message: string };

/**
 * Everything one Garuda process needs to run turns: settings, executor, permissions,
 * the session and its store. The CLI (one-shot and chat) and the eval runner share it.
 * It never imports the CLI.
 */
export interface RuntimeOptions {
  root: string;
  modelId: string;
  /** Context window and price of the model. Default: Garuda's table of Claude models. */
  modelInfo?: ModelInfo;
  /** Output token limit per response. Default: the loop's default. */
  maxTokens?: number;
  /** The model client, or a function that loads it on first use (keeps startup fast, N3). */
  model: ModelClient | (() => Promise<ModelClient>);
  approver: Approver;
  store: SessionStore;
  /** Resume the latest session (true) or a given one. */
  resume?: true | string;
  /** Default: read .garuda/settings.json in the root. */
  settings?: Settings;
  onEvent?: (event: AgentEvent) => void;
  /** Warnings for the user outside a tool call, for example from MCP servers. */
  onNotice?: (text: string) => void;
  /**
   * MCP servers (0.2). Default: read ~/.garuda/mcp.json and <root>/.garuda/mcp.json.
   * false: no MCP servers (the evals use this, so results do not depend on the user's setup).
   */
  mcp?: false | { home?: string; env?: NodeJS.ProcessEnv };
  /** Hooks (0.2). Default: read ~/.garuda/hooks.json and <root>/.garuda/hooks.json. false: none. */
  hooks?: false | { home?: string };
  /** Custom slash commands (0.4). Default: ~/.garuda/commands and .garuda/commands. false: none. */
  commands?: false | { home?: string };
  /** Language profiles (0.3). Default: detect them from marker files in the root. */
  profiles?: LanguageProfile[];
  /**
   * The model of the explore subagent (0.3). Default: the main model. Only the user picks it
   * (command line or environment), never the project settings.
   */
  subagentModel?: { spec: string; model: () => Promise<ModelClient>; info: ModelInfo };
}

export class Runtime {
  readonly root: string;
  readonly modelId: string;
  readonly limits: RunLimits;
  readonly price: Price | undefined;
  private readonly maxTokens: number | undefined;
  readonly executor: Executor;
  /** Set when "auto" found no OS sandbox. The CLI shows it once. */
  readonly executorNotice: string | undefined;
  readonly system: string;
  /** Build tools found in the root (0.3): Maven, Gradle, Python. */
  readonly profiles: readonly LanguageProfile[];
  /** The local code index. It loads its language experts on first use. */
  readonly knowledge: KnowledgeIndex;
  /** Which code index tools the model gets. */
  readonly codeIndex: CodeIndexMode;
  /** The explore subagent's model spec, or undefined when explore is off (0.3). */
  readonly exploreModel: string | undefined;
  private readonly permissions: PermissionEngine;
  private readonly store: SessionStore;
  private readonly tools: ToolRegistry;
  private readonly onEvent: ((event: AgentEvent) => void) | undefined;
  private model: ModelClient | (() => Promise<ModelClient>);
  private current: Session | undefined;
  private readonly approver: Approver;
  private readonly settings: Settings;
  private readonly mcpServers: ServerConfig[];
  private readonly mcpOptions: { home?: string; env?: NodeJS.ProcessEnv };
  private readonly onNotice: ((text: string) => void) | undefined;
  private mcp: McpManager | undefined;
  private mcpStarted: Promise<void> | undefined;
  private readonly hookConfig: { user: Hook[]; project: Hook[]; home: string };
  private customCommands: CustomCommand[] = [];
  private commandsHome = homedir();
  /** Hashes of project commands that the user allowed for this process ("Yes, this time"). */
  private readonly allowedCommands = new Set<string>();
  private hookRunner: HookRunner | undefined;
  private hooksStarted: Promise<void> | undefined;

  private constructor(
    options: RuntimeOptions,
    settings: Settings,
    system: string,
    choice: ExecutorChoice,
    mcpServers: ServerConfig[],
    hookConfig: { user: Hook[]; project: Hook[]; home: string },
    profiles: LanguageProfile[],
  ) {
    this.hookConfig = hookConfig;
    this.profiles = profiles;
    this.approver = options.approver;
    this.settings = settings;
    this.mcpServers = mcpServers;
    this.mcpOptions = options.mcp === false || options.mcp === undefined ? {} : options.mcp;
    this.onNotice = options.onNotice;
    this.root = options.root;
    this.modelId = options.modelId;
    this.model = options.model;
    this.store = options.store;
    this.onEvent = options.onEvent;
    this.system = system;
    this.knowledge = new KnowledgeIndex(options.root);
    this.codeIndex = settings.codeIndex ?? DEFAULT_CODE_INDEX_MODE;
    const web = settings.web ?? { enabled: true, allowLocalhost: false };
    this.tools = new ToolRegistry(
      defaultTools({
        codeIndex: this.codeIndex,
        ...(web.enabled ? { web: { allowLocalhost: web.allowLocalhost } } : {}),
        todo: settings.todo?.enabled === true,
      }),
    );
    const info = options.modelInfo ?? lookupModel(options.modelId);
    this.maxTokens = options.maxTokens;
    this.price = settings.price ?? info.price;
    this.limits = {
      maxSteps: settings.maxSteps ?? DEFAULT_MAX_STEPS,
      tokenBudget: settings.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
      contextWindow: settings.contextWindow ?? info.contextWindow,
    };
    this.executor = choice.executor;
    this.executorNotice = choice.notice;
    this.permissions = new PermissionEngine({
      root: options.root,
      settings,
      approver: options.approver,
      isolation: this.executor.isolation,
      access: profileAccess(profiles),
    });
    this.exploreModel = undefined;
    // Off by default: an A/B eval (hard suite, 3 runs per arm) showed no gain in steps or cost.
    if (settings.subagents?.enabled === true) {
      const sub = options.subagentModel;
      let subClient: ModelClient | undefined;
      const subPrice = sub === undefined ? this.price : sub.info.price;
      this.exploreModel = sub?.spec ?? options.modelId;
      this.tools.register(
        createExploreTool({
          model: {
            spec: this.exploreModel,
            client:
              sub === undefined
                ? () => this.client()
                : async () => {
                    subClient ??= await sub.model();
                    return subClient;
                  },
            contextWindow: sub?.info.contextWindow ?? this.limits.contextWindow,
            ...(subPrice === undefined ? {} : { price: subPrice }),
          },
          tools: new ToolRegistry(readOnlyTools(this.codeIndex)),
          permissions: this.permissions,
          knowledge: this.knowledge,
          hooks: () => this.hookRunner,
          journal: (childId) =>
            this.current === undefined ? undefined : this.store.openChild(this.current.id, childId),
          limits: {
            maxSteps: settings.subagents?.maxSteps ?? DEFAULT_EXPLORE_LIMITS.maxSteps,
            tokenBudget: settings.subagents?.tokenBudget ?? DEFAULT_EXPLORE_LIMITS.tokenBudget,
          },
          executor: { name: this.executor.name, isolation: this.executor.isolation },
        }),
      );
    }
  }

  /** The main model client, loaded on first use (N3). */
  private async client(): Promise<ModelClient> {
    if (typeof this.model === "function") this.model = await this.model();
    return this.model;
  }

  static async create(options: RuntimeOptions): Promise<Runtime> {
    const settings = options.settings ?? (await loadSettings(options.root));
    const choice = createExecutor(settings.executor);
    let mcpServers: ServerConfig[] = [];
    if (options.mcp !== false) {
      const loaded = await loadMcpConfig({
        home: options.mcp?.home ?? homedir(),
        root: options.root,
      });
      mcpServers = loaded.servers;
      for (const problem of loaded.problems) options.onNotice?.(problem);
    }
    let hookConfig = { user: [] as Hook[], project: [] as Hook[], home: homedir() };
    if (options.hooks !== false) {
      const home = options.hooks?.home ?? homedir();
      const loaded = await loadHooks(home, options.root);
      hookConfig = { user: loaded.user, project: loaded.project, home };
      for (const problem of loaded.problems) options.onNotice?.(problem);
    }
    const profiles = options.profiles ?? detectProfiles(options.root);
    const system = buildSystemPrompt(
      options.root,
      await loadInstructions(options.root),
      await loadMemory(options.root),
      {
        codeIndex: settings.codeIndex ?? DEFAULT_CODE_INDEX_MODE,
        sandboxed: choice.executor.isolation !== "none",
        mcp: mcpServers.some((s) => s.def.enabled),
        web: settings.web?.enabled ?? true,
        hooks: hookConfig.user.length + hookConfig.project.length > 0,
        languages: profileNotes(profiles),
        explore: settings.subagents?.enabled === true,
        todo: settings.todo?.enabled === true,
      },
    );
    const runtime = new Runtime(
      options,
      settings,
      system,
      choice,
      mcpServers,
      hookConfig,
      profiles,
    );
    if (options.commands !== false) {
      runtime.commandsHome = options.commands?.home ?? homedir();
      const loaded = await loadCommands({
        home: runtime.commandsHome,
        root: options.root,
        builtins: BUILTIN_COMMANDS,
      });
      runtime.customCommands = loaded.commands;
      for (const problem of loaded.problems) options.onNotice?.(problem);
    }
    if (options.resume !== undefined) {
      runtime.current = await resumeSession({
        store: options.store,
        root: options.root,
        start: runtime.startFields(),
        ...(options.resume === true ? {} : { sessionId: options.resume }),
      });
    }
    return runtime;
  }

  /** Custom slash commands (0.4), sorted by name. */
  get commands(): readonly CustomCommand[] {
    return this.customCommands;
  }

  /**
   * The prompt for a custom command line (`/name args`). A project command shows its text and
   * asks first; "remember" pins the answer to the file's hash in ~/.garuda/trust.json.
   */
  async resolveCommand(line: string, signal: AbortSignal): Promise<CommandResolution> {
    const parsed = parseCommandLine(line);
    const command =
      parsed === undefined ? undefined : this.customCommands.find((c) => c.name === parsed.name);
    if (parsed === undefined || command === undefined) return { kind: "none" };
    if (command.source === "project" && !this.allowedCommands.has(command.hash)) {
      const trust = await TrustStore.open(this.commandsHome);
      const known = trust.commandHash(this.root, command.name);
      if (known !== command.hash) {
        const request = commandConsent(command, known !== undefined, this.executor.isolation);
        const choice = await this.approver.ask(request, signal);
        if (choice === "deny") {
          return { kind: "denied", message: `You did not run /${command.name}.` };
        }
        if (choice === "session") await trust.setCommandHash(this.root, command.name, command.hash);
      }
      this.allowedCommands.add(command.hash);
    }
    return { kind: "prompt", prompt: expandCommand(command, parsed.args), command };
  }

  /** The current session, or undefined before the first turn of a new session. */
  get session(): Session | undefined {
    return this.current;
  }

  /** Start a new session at the next turn. The old one stays on disk. */
  newSession(): void {
    this.current = undefined;
  }

  /** Run one turn: the user's prompt, then the loop until it stops. */
  async runTurn(prompt: string, signal: AbortSignal): Promise<AgentResult> {
    await this.startHooks(signal);
    await this.startMcp(signal);
    const session = this.ensureSession();
    addUserMessage(session, prompt, this.mcp?.takeNotes() ?? []);
    return runAgent(session, {
      model: await this.client(),
      tools: this.tools,
      system: this.system,
      permissions: this.permissions,
      executor: this.executor,
      knowledge: this.knowledge,
      ...(this.hookRunner === undefined ? {} : { hooks: this.hookRunner }),
      maxSteps: this.limits.maxSteps,
      tokenBudget: this.limits.tokenBudget,
      ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
      contextWindow: this.limits.contextWindow,
      ...(this.price === undefined ? {} : { price: this.price }),
      ...(this.onEvent === undefined ? {} : { onEvent: this.onEvent }),
      signal,
    });
  }

  /** What this session adds to the base tools, for the start banner. Counts configured items. */
  extras(): string[] {
    // The build tools first: they say what kind of project this is.
    const out: string[] = this.profiles.map((p) => p.label);
    const servers = this.mcpServers.filter((s) => s.def.enabled).length;
    if (servers > 0) out.push(`${servers} MCP server${servers === 1 ? "" : "s"}`);
    const hooks = this.hookConfig.user.length + this.hookConfig.project.length;
    if (hooks > 0) out.push(`${hooks} hook${hooks === 1 ? "" : "s"}`);
    if (this.tools.get("web_fetch") !== undefined) out.push("web_fetch");
    if (this.codeIndex !== "off") out.push(`code index: ${this.codeIndex}`);
    if (this.exploreModel !== undefined)
      out.push(this.exploreModel === this.modelId ? "explore" : `explore: ${this.exploreModel}`);
    return out;
  }

  /** The active hooks, for /hooks. */
  hookLines(): string[] {
    return this.hookRunner?.describe() ?? [];
  }

  /**
   * Set up the hooks before the first turn, once. User hooks are trusted. Project hooks run only
   * after the user saw every command and agreed; the answer can be pinned to a hash of them.
   */
  private async startHooks(signal: AbortSignal): Promise<void> {
    const { user, project, home } = this.hookConfig;
    if (user.length + project.length === 0) return;
    this.hooksStarted ??= (async () => {
      let active = [...user];
      if (project.length > 0) {
        const trust = await TrustStore.open(home);
        const hash = hooksHash(project);
        const known = trust.hooksHash(this.root);
        if (known === hash) {
          active = [...active, ...project];
        } else {
          const file = join(this.root, HOOKS_FILE);
          const request = hooksConsent(project, file, this.executor.isolation, known !== undefined);
          const choice = await this.approver.ask(request, signal);
          if (choice !== "deny") active = [...active, ...project];
          if (choice === "session") await trust.setHooksHash(this.root, hash);
        }
      }
      if (active.length === 0) return;
      this.hookRunner = new HookRunner({
        root: this.root,
        hooks: active,
        executor: this.executor,
        permissions: this.permissions,
        ...(this.onNotice === undefined ? {} : { notify: this.onNotice }),
      });
    })();
    try {
      await this.hooksStarted;
    } catch (error) {
      this.hooksStarted = undefined;
      throw error;
    }
  }

  /** MCP server states, for /mcp. */
  mcpStatus(): McpServerStatus[] {
    return this.mcp?.status() ?? [];
  }

  /** Stop the MCP servers. The CLI calls it before it exits. */
  async close(): Promise<void> {
    await this.mcp?.close();
  }

  /**
   * Start the MCP servers before the first turn, once. Consent questions go through the
   * approver, so they appear in the chat. Their tools join the registry for the session.
   */
  private async startMcp(signal: AbortSignal): Promise<void> {
    if (this.mcpServers.length === 0) return;
    this.mcpStarted ??= (async () => {
      // The MCP SDK loads only when a server is configured (N3).
      const { McpManager } = await import("../mcp/manager.js");
      const manager = new McpManager({
        root: this.root,
        executor: this.executor,
        approver: this.approver,
        trust: await TrustStore.open(this.mcpOptions.home ?? homedir()),
        ...(this.settings.sandbox === undefined ? {} : { sandbox: this.settings.sandbox }),
        ...(this.mcpOptions.env === undefined ? {} : { env: this.mcpOptions.env }),
        ...(this.onNotice === undefined ? {} : { notify: this.onNotice }),
      });
      this.mcp = manager;
      for (const tool of await manager.start(this.mcpServers, signal)) this.tools.register(tool);
    })();
    try {
      await this.mcpStarted;
    } catch (error) {
      // Ctrl-C during the start: try again at the next turn.
      this.mcpStarted = undefined;
      await this.mcp?.close();
      throw error;
    }
  }

  /** Record a turn that ended with no result: Ctrl-C ("interrupted") or an error. */
  recordStop(reason: "interrupted" | "error"): void {
    this.current?.journal?.write({ type: "end", stopReason: reason, steps: 0 });
  }

  private ensureSession(): Session {
    if (this.current !== undefined) return this.current;
    const id = newSessionId();
    const session = createSession(this.root, id, this.store.open(id));
    session.journal?.write({ type: "start", sessionId: id, ...this.startFields() });
    this.current = session;
    return session;
  }

  private startFields(): Omit<StartRecord, "t" | "type" | "sessionId"> {
    return {
      root: this.root,
      version: VERSION,
      model: this.modelId,
      executor: this.executor.name,
      isolation: this.executor.isolation,
      limits: this.limits,
    };
  }
}
