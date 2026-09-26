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
import { loadLspConfig } from "../lsp/config.js";
import type { InstallResult } from "../lsp/install.js";
import type { LspManager } from "../lsp/manager.js";
import type { LspLanguage } from "../lsp/servers.js";
import { loadMcpConfig, type ServerConfig } from "../mcp/config.js";
import type { McpManager, McpServerStatus } from "../mcp/manager.js";
import { TrustStore } from "../mcp/trust.js";
import { lookupModel, type ModelInfo, type Price } from "../model/pricing.js";
import type { ModelClient } from "../model/types.js";
import { PermissionEngine } from "../permissions/engine.js";
import { loadSettings, type Settings } from "../permissions/settings.js";
import type { AgentMode, Approver } from "../permissions/types.js";
import { createExecutor, type ExecutorChoice } from "../sandbox/index.js";
import type { Executor } from "../sandbox/types.js";
import type { RunLimits, StartRecord } from "../session/records.js";
import { resumeSession } from "../session/resume.js";
import {
  addSnapshot,
  addUserMessage,
  createSession,
  redoTurn,
  type Session,
  undoTurn,
} from "../session/session.js";
import { newSessionId, type SessionStore } from "../session/store.js";
import { defaultTools, readOnlyTools } from "../tools/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { filesText, undoQuestion } from "../undo/question.js";
import { SLOW_SNAPSHOT_MS, SnapshotError, SnapshotStore, storeDir } from "../undo/snapshots.js";
import { VERSION } from "../version.js";

/**
 * The note that starts each plan-mode turn (0.4). The system prompt stays the same in both modes
 * (N2); the permission engine and the sandbox enforce the mode, this note explains it.
 */
export const PLAN_NOTE =
  "Plan mode is on. Investigate and write a plan; do not change anything. File edits, file writes and remember are blocked, and bash runs in a sandbox that cannot write the project (temp folders only), so read-only commands and tests that write nothing in the project still work. End with a numbered plan: the files to change, the change in each, and how to test it.";

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
  mcp?:
    | false
    | { home?: string; env?: NodeJS.ProcessEnv; openBrowser?: (url: URL) => Promise<void> };
  /** Hooks (0.2). Default: read ~/.garuda/hooks.json and <root>/.garuda/hooks.json. false: none. */
  hooks?: false | { home?: string };
  /** The mode of the first turn (0.4). Default: build. */
  mode?: AgentMode;
  /** Custom slash commands (0.4). Default: ~/.garuda/commands and .garuda/commands. false: none. */
  commands?: false | { home?: string };
  /** Language profiles (0.3). Default: detect them from marker files in the root. */
  profiles?: LanguageProfile[];
  /**
   * The model of the explore subagent (0.3). Default: the main model. Only the user picks it
   * (command line or environment), never the project settings.
   */
  subagentModel?: { spec: string; model: () => Promise<ModelClient>; info: ModelInfo };
  /**
   * Language server diagnostics (0.4). `enabled` overrides the setting (the --lsp flag, evals).
   * `home` holds ~/.garuda/lsp.json and the managed servers; `path` is the PATH to search.
   */
  /**
   * Undo (0.4): a snapshot of the files before each turn, in ~/.garuda/snapshots (`home` overrides
   * the home folder). Absent: no snapshots (tests, evals). The CLI passes it; the setting
   * `undo.enabled: false` turns it off.
   */
  undo?: { home?: string };
  lsp?: {
    enabled?: boolean;
    home?: string;
    path?: string;
    firstTimeoutMs?: number;
    timeoutMs?: number;
  };
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
  private readonly mcpOptions:
    | Exclude<RuntimeOptions["mcp"], false | undefined>
    | Record<string, never>;
  private readonly onNotice: ((text: string) => void) | undefined;
  private mcp: McpManager | undefined;
  private mcpStarted: Promise<void> | undefined;
  private readonly hookConfig: { user: Hook[]; project: Hook[]; home: string };
  /** The mode that the user chose; the next turn uses it (0.4). */
  private selectedMode: AgentMode;
  /** The mode of the running turn: a switch during a turn waits for the next one. */
  private turnMode: AgentMode = "build";
  private customCommands: CustomCommand[] = [];
  private commandsHome = homedir();
  /** Hashes of project commands that the user allowed for this process ("Yes, this time"). */
  private readonly allowedCommands = new Set<string>();
  private hookRunner: HookRunner | undefined;
  private hooksStarted: Promise<void> | undefined;
  /** The snapshot store for undo, or undefined when undo is off (0.4). */
  private snapshots: SnapshotStore | undefined;
  /** Notes for the next turn, for example after an undo that kept the conversation. */
  private readonly pendingNotes: string[] = [];
  /** LSP diagnostics after edits are on (0.4). */
  readonly lspEnabled: boolean;
  private readonly lspOptions: NonNullable<RuntimeOptions["lsp"]>;
  private lspAutoInstall = false;
  private lspManager: LspManager | undefined;
  private lspLoading: Promise<LspManager> | undefined;

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
    this.lspOptions = options.lsp ?? {};
    if (options.undo !== undefined && settings.undo?.enabled !== false) {
      this.snapshots = new SnapshotStore(
        options.root,
        choice.executor,
        storeDir(options.root, options.undo.home),
      );
    }
    this.lspEnabled = options.lsp?.enabled ?? settings.lsp?.enabled === true;
    this.selectedMode = options.mode ?? "build";
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
      mode: () => this.turnMode,
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
        lsp: options.lsp?.enabled ?? settings.lsp?.enabled === true,
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
    if (runtime.lspEnabled) {
      try {
        runtime.lspAutoInstall = (await loadLspConfig(runtime.lspHome)).autoInstall;
      } catch (error) {
        options.onNotice?.((error as Error).message);
      }
    }
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

  /** The mode for the next turn: build or plan (0.4). */
  get mode(): AgentMode {
    return this.selectedMode;
  }

  /** Switch the mode. It applies from the next turn, never in the middle of one. */
  setMode(mode: AgentMode): void {
    this.selectedMode = mode;
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
    this.turnMode = this.selectedMode;
    // jdtls imports a Maven or Gradle project for a while: start it now, not at the first edit.
    if (this.lspEnabled && this.profiles.some((p) => p.id === "maven" || p.id === "gradle")) {
      void this.lsp().then((m) => m.warm("java"));
    }
    await this.snapshot(session, prompt, signal);
    const notes = [...this.pendingNotes.splice(0), ...(this.mcp?.takeNotes() ?? [])];
    if (this.turnMode === "plan") notes.unshift(PLAN_NOTE);
    addUserMessage(session, prompt, notes);
    return runAgent(session, {
      model: await this.client(),
      tools: this.tools,
      system: this.system,
      permissions: this.permissions,
      executor: this.executor,
      knowledge: this.knowledge,
      ...(this.hookRunner === undefined ? {} : { hooks: this.hookRunner }),
      ...(this.lspEnabled
        ? {
            diagnostics: async (absolute: string, shown: string, text: string, s: AbortSignal) =>
              (await this.lsp()).diagnostics(absolute, shown, text, s),
          }
        : {}),
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
    if (this.selectedMode === "plan") out.push("plan mode");
    if (this.lspEnabled) out.push("LSP");
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

  /** The names of the tools the model sees, sorted (JSON output, 0.5). */
  toolNames(): string[] {
    return this.tools.specs().map((spec) => spec.name);
  }

  /** MCP server states, for /mcp. */
  mcpStatus(): McpServerStatus[] {
    return this.mcp?.status() ?? [];
  }

  /**
   * /init (0.5): migrate other agents' files, offer git init, and give the prompt of the init turn.
   * The files it writes are new only; the turn's own writes go through the normal approvals.
   */
  async init(signal: AbortSignal): Promise<{ report: string[]; prompt: string }> {
    const { runInit } = await import("../init/run.js");
    const result = await runInit({
      root: this.root,
      home: this.commandsHome,
      approver: this.approver,
      executor: this.executor,
      signal,
    });
    const report = [...result.report];
    if (this.selectedMode === "plan") {
      report.push(
        "Plan mode is on: the init turn can only read and plan. /build lets it write AGENTS.md.",
      );
    }
    return { report, prompt: result.prompt };
  }

  /** /mcp logout (0.4): forget the OAuth tokens of a remote server. Returns how many entries went. */
  async mcpLogout(server: string): Promise<number> {
    if (this.mcp !== undefined) return this.mcp.logout(server);
    const { AuthStore } = await import("../mcp/oauth.js");
    const store = await AuthStore.open(this.mcpOptions.home ?? homedir());
    return store.remove(server);
  }

  /** Stop the MCP and language servers. The CLI calls it before it exits. */
  async close(): Promise<void> {
    await Promise.all([this.mcp?.close(), this.lspManager?.close()]);
  }

  private get lspHome(): string {
    return this.lspOptions.home ?? homedir();
  }

  /** The language servers, created on the first edit (N3: the module loads only then). */
  private lsp(): Promise<LspManager> {
    this.lspLoading ??= (async () => {
      const { LspManager } = await import("../lsp/manager.js");
      const o = this.lspOptions;
      this.lspManager = new LspManager({
        root: this.root,
        executor: this.executor,
        policy: () => this.permissions.serverPolicy(),
        home: this.lspHome,
        ...(o.path === undefined ? {} : { path: o.path }),
        ...(o.firstTimeoutMs === undefined ? {} : { firstTimeoutMs: o.firstTimeoutMs }),
        ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
        ...(this.onNotice === undefined ? {} : { notify: this.onNotice }),
        ...(this.lspAutoInstall
          ? { install: (language, signal) => this.askInstall(language, signal) }
          : {}),
      });
      return this.lspManager;
    })();
    return this.lspLoading;
  }

  /** The /lsp text: on or off, and the server for each language. Starts nothing. */
  async lspStatus(): Promise<string> {
    const { lspStatusText } = await import("../lsp/manager.js");
    const how = 'Turn them on with --lsp, or "lsp": { "enabled": true } in .garuda/settings.json.';
    return lspStatusText((await this.lsp()).status(), { on: this.lspEnabled, how });
  }

  /** Install a language server into ~/.garuda/lsp (the user asked for it). */
  async installLsp(language: LspLanguage, signal: AbortSignal): Promise<InstallResult> {
    const { installServer } = await import("../lsp/install.js");
    const result = await installServer(language, {
      executor: this.executor,
      home: this.lspHome,
      signal,
    });
    if (result.ok) (await this.lsp()).reset(language);
    return result;
  }

  /** autoInstall (~/.garuda/lsp.json): ask before a managed install. */
  private async askInstall(language: LspLanguage, signal: AbortSignal): Promise<boolean> {
    const { installCommand } = await import("../lsp/install.js");
    const { LANGUAGE_LABELS } = await import("../lsp/manager.js");
    const { managedLabel, managedDir } = await import("../lsp/servers.js");
    const dir = managedDir(language, this.lspHome);
    const choice = await this.approver.ask(
      {
        tool: "lsp",
        target: { kind: "input", json: "{}" },
        preview: [
          `Garuda can install ${managedLabel(language)} into ${dir}.`,
          "The download runs outside the sandbox. The server then runs in the sandbox.",
          `  $ ${installCommand(language, dir)}`,
        ].join("\n"),
        isolation: this.executor.isolation,
        title: `No ${LANGUAGE_LABELS[language]} language server was found.`,
        question: "Install it?",
        choices: ["once", "deny"],
        labels: { once: "Yes, install it", deny: "No, go on without diagnostics" },
      },
      signal,
    );
    if (choice === "deny") return false;
    const result = await this.installLsp(language, signal);
    if (!result.ok) this.onNotice?.(`The install failed: ${result.output ?? ""}`);
    return result.ok;
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
      const { AuthStore } = await import("../mcp/oauth.js");
      const manager = new McpManager({
        root: this.root,
        executor: this.executor,
        approver: this.approver,
        trust: await TrustStore.open(this.mcpOptions.home ?? homedir()),
        auth: await AuthStore.open(this.mcpOptions.home ?? homedir()),
        ...(this.mcpOptions.openBrowser === undefined
          ? {}
          : { openBrowser: this.mcpOptions.openBrowser }),
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

  /** True when turns get snapshots (0.4). */
  get undoEnabled(): boolean {
    return this.snapshots !== undefined;
  }

  /** Snapshot the files before a turn. A failure turns undo off with a notice; the turn goes on. */
  private async snapshot(session: Session, prompt: string, signal: AbortSignal): Promise<void> {
    const store = this.snapshots;
    if (store === undefined) return;
    const started = Date.now();
    try {
      const tree = await store.take(signal);
      const ms = Date.now() - started;
      addSnapshot(session, tree, prompt, ms);
      if (ms > SLOW_SNAPSHOT_MS) {
        this.snapshots = undefined;
        this.onNotice?.(
          `The undo snapshot took ${(ms / 1000).toFixed(1)} s, so undo is off for this session. Add big folders to .gitignore, or set "undo": { "enabled": false } in .garuda/settings.json.`,
        );
      }
    } catch (error) {
      if (signal.aborted) throw error;
      this.snapshots = undefined;
      this.onNotice?.(`Undo is off for this session: ${(error as Error).message}`);
    }
  }

  /**
   * /undo (0.4): show what the last turn changed, ask, then restore the files and take the turn out
   * of the conversation. Returns the text for the user.
   */
  async undo(signal: AbortSignal): Promise<string> {
    return this.undoRedo("undo", signal);
  }

  /** /redo (0.4): bring back the last undone turn: its files and its messages. */
  async redo(signal: AbortSignal): Promise<string> {
    return this.undoRedo("redo", signal);
  }

  private async undoRedo(kind: "undo" | "redo", signal: AbortSignal): Promise<string> {
    try {
      return kind === "undo" ? await this.undoNow(signal) : await this.redoNow(signal);
    } catch (error) {
      if (!(error instanceof SnapshotError)) throw error;
      return `The ${kind} failed, and no file changed: ${error.message}`;
    }
  }

  private async undoNow(signal: AbortSignal): Promise<string> {
    const store = this.snapshots;
    if (store === undefined) return "Undo is off for this session.";
    const session = this.current;
    const point = session?.undo.points.at(-1);
    if (session === undefined || point === undefined) return "There is no turn to undo.";
    const now = await store.take(signal);
    const changes = await store.changes(now, point.tree, signal);
    const choice = await this.approver.ask(
      undoQuestion("undo", point.prompt, changes, point.conversation, this.executor.isolation),
      signal,
    );
    if (choice === "deny") return "Nothing changed.";
    await store.restore(now, point.tree, signal);
    undoTurn(session, now);
    if (!point.conversation) {
      this.pendingNotes.push(
        `The user undid the turn "${point.prompt}": its file changes are gone. Read files again before you edit them.`,
      );
    }
    return `Undid "${point.prompt}": ${filesText(changes)}${point.conversation ? "; the conversation went back too" : ""}. /redo brings it back.`;
  }

  private async redoNow(signal: AbortSignal): Promise<string> {
    const store = this.snapshots;
    if (store === undefined) return "Undo is off for this session.";
    const session = this.current;
    const entry = session?.undo.redo.at(-1);
    if (session === undefined || entry === undefined) return "There is nothing to redo.";
    const now = await store.take(signal);
    const changes = await store.changes(now, entry.after, signal);
    const choice = await this.approver.ask(
      undoQuestion(
        "redo",
        entry.point.prompt,
        changes,
        entry.removed.length > 0,
        this.executor.isolation,
      ),
      signal,
    );
    if (choice === "deny") return "Nothing changed.";
    await store.restore(now, entry.after, signal);
    redoTurn(session);
    if (entry.removed.length === 0) {
      this.pendingNotes.push(
        `The user redid the turn "${entry.point.prompt}": its file changes are back. Read files again before you edit them.`,
      );
    }
    return `Redid "${entry.point.prompt}": ${filesText(changes)}.`;
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
