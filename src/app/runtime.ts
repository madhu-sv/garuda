import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentTool } from "../agents/agentTool.js";
import type { ChildModel } from "../agents/child.js";
import { agentConsent, type CustomAgent, loadAgents } from "../agents/custom.js";
import { createExploreTool, DEFAULT_EXPLORE_LIMITS } from "../agents/explore.js";
import { createMoeDispatchTool } from "../agents/moe.js";
import { AuditLogger } from "../audit/logger.js";
import { BUILTIN_COMMANDS } from "../commands/builtins.js";
import {
  type CustomCommand,
  commandConsent,
  expandCommand,
  loadCommands,
  parseCommandLine,
} from "../commands/custom.js";
import { type CompactionResult, compactNow } from "../context/compact.js";
import { buildSystemPrompt, loadInstructions, loadMemory } from "../context/instructions.js";
import {
  detectFormatters,
  type Formatter,
  formatCommand,
  formatterFor,
} from "../format/formatters.js";
import { HOOKS_FILE, type Hook, hooksHash, loadHooks } from "../hooks/config.js";
import { HookRunner, hooksConsent } from "../hooks/runner.js";
import type { PlanForJob } from "../jobs/create.js";
import { detectTestCommand, type TestRun, tail } from "../jobs/proof.js";
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
  DEFAULT_MAX_TOKENS,
  DEFAULT_TOKEN_BUDGET,
  runAgent,
  thinkingMaxTokens,
} from "../loop/runAgent.js";
import { loadLspConfig } from "../lsp/config.js";
import type { InstallResult } from "../lsp/install.js";
import type { LspManager } from "../lsp/manager.js";
import type { LspLanguage } from "../lsp/servers.js";
import { loadMcpConfig, type ServerConfig } from "../mcp/config.js";
import type { McpManager, McpServerStatus } from "../mcp/manager.js";
import { neutralizeTags } from "../mcp/sanitize.js";
import { TrustStore } from "../mcp/trust.js";
import {
  aliasModel,
  lookupModel,
  type ModelInfo,
  type Price,
  responseCost,
} from "../model/pricing.js";
import { fitThinking } from "../model/thinking.js";
import type {
  Message,
  ModelClient,
  ModelResponse,
  ServerToolSpec,
  ThinkingRequest,
} from "../model/types.js";
import { expandAllowlist, hostAllowed, NETWORK_PORTS } from "../net/allowlist.js";
import type { NetworkProxy, ProxyDecision } from "../net/proxy.js";
import { PermissionEngine } from "../permissions/engine.js";
import { displayPath, PathOutsideRootError, resolveInRoot } from "../permissions/pathGuard.js";
import {
  assertModelAllowedByPolicy,
  ignoredProjectPolicy,
  type TeamPolicy,
} from "../permissions/policy.js";
import { loadSettings, type Settings } from "../permissions/settings.js";
import type { AgentMode, Approver, CallTarget } from "../permissions/types.js";
import { createExecutor, type ExecutorChoice } from "../sandbox/index.js";
import type { Executor } from "../sandbox/types.js";
import { FileTracker } from "../session/fileTracker.js";
import type { SessionSummary } from "../session/list.js";
import type { RunLimits, SessionRecord, StartRecord } from "../session/records.js";
import { resumeSession } from "../session/resume.js";
import { addUserMessage, createSession, type Session } from "../session/session.js";
import { newSessionId, type SessionStore } from "../session/store.js";
import { loadSkills, type Skill, skillConsent } from "../skills/load.js";
import { createSkillTool, skillText } from "../skills/tool.js";
import { defaultTools, readOnlyTools } from "../tools/index.js";
import { ToolRegistry } from "../tools/registry.js";
import type { FormatSource } from "../tools/types.js";
import { createWebSearchTool } from "../tools/webSearch.js";
import { type FileStat, SnapshotStore, storeDir } from "../undo/snapshots.js";
import { VERSION } from "../version.js";
import type { ClaudeSearchConfig, SearchConfig } from "../web/search.js";
import { attachMentions } from "./mentions.js";
import { ModelState, modelFacts } from "./modelState.js";
import { networkConsent, networkHash, networkNote, nodeBinary } from "./network.js";
import { deleteSession, findSession, listSessions, renameSession } from "./sessionManager.js";
import { SnapshotError, UndoCoordinator } from "./undoCoordinator.js";

export { modelFacts };

/** A formatter that runs longer than this is stopped (0.10). */
const FORMAT_TIMEOUT_MS = 20_000;
/**
 * The note that starts each plan-mode turn (0.4). The system prompt stays the same in both modes
 * (N2); the permission engine and the sandbox enforce the mode, this note explains it.
 */
export const PLAN_NOTE =
  "Plan mode is on. Investigate and write a plan; do not change anything. File edits, file writes and remember are blocked, and bash runs in a sandbox that cannot write the project (temp folders only), so read-only commands and tests that write nothing in the project still work. End with a numbered plan: the files to change, the change in each, and how to test it. Then add a ```permissions block with one rule per line for the calls the build needs beyond the sandbox: edit_file(path) and write_file(path) for each file to change or create (globs such as src/** are fine), bash(command) for commands that need the network, and web_fetch(host) for pages. Commands that stay in the project (tests, builds) need no line.";

/** The settings with the team policy's step and token limits applied (pure: a new object). */
export function withPolicyLimits(settings: Settings, policy: TeamPolicy | undefined): Settings {
  const limits = policy?.limits;
  if (limits === undefined) return settings;
  const min = (own: number | undefined, cap: number | undefined) =>
    cap === undefined ? own : own === undefined ? cap : Math.min(own, cap);
  const maxSteps = min(settings.maxSteps, limits.maxSteps);
  const tokenBudget = min(settings.tokenBudget, limits.tokenBudget);
  return {
    ...settings,
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
  };
}

/** What a line that starts with "/" means, when it is not a built-in command. */
export type CommandResolution =
  | { kind: "none" }
  | { kind: "prompt"; prompt: string; command?: CustomCommand; skill?: Skill }
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
  /**
   * Team security policy (0.17). The CLI loads it with loadTeamPolicy (the managed file and
   * ~/.garuda/policy.json). Absent: no policy. The runtime never reads a project's policy file.
   */
  policy?: TeamPolicy;
  /** The files the policy came from, for /audit and messages. */
  policySources?: string[];
  /**
   * The audit log (merge gate): `dir` is the project's audit folder (the CLI passes
   * auditDirFor(root) in ~/.garuda/audit). Absent: no audit log (tests, evals), so nothing is
   * written outside the test's own folders. The team policy can still turn it off.
   */
  audit?: { dir: string };
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
  /**
   * Skills (0.5): ~/.garuda/skills, ~/.claude/skills, .garuda/skills and .claude/skills (`home`
   * overrides the home folder). Absent: no skills (tests, evals), so results do not depend on the
   * user's setup. The CLI passes it; the setting `skills.enabled: false` turns it off.
   */
  skills?: { home?: string };
  /**
   * Custom agents (0.5): ~/.garuda/agents, ~/.claude/agents, .garuda/agents and .claude/agents.
   * Absent: no agents (tests, evals). `resolveModel` turns a model id from a user agent file into a
   * client (the CLI passes its provider lookup); without it, such agents fail with a message.
   */
  /**
   * Web search (0.5): the backend from ~/.garuda/search.json or the environment (the CLI loads it).
   * Absent: no web_search tool. `web.enabled: false` in the settings also turns it off.
   */
  search?: { config?: SearchConfig; claude?: ClaudeSearchConfig; fetch?: typeof fetch };
  agents?: {
    home?: string;
    resolveModel?: (spec: string) => {
      spec: string;
      model: () => Promise<ModelClient>;
      info: ModelInfo;
    };
  };
  /**
   * Model switching for /models (0.6). `resolve` turns a spec into a client (the CLI passes its
   * provider lookup, as for agents); `configured` lists the specs of ~/.garuda/models.json.
   * Absent: /models lists the known models but cannot switch.
   */
  models?: {
    resolve: (spec: string) => {
      spec: string;
      model: () => Promise<ModelClient>;
      info: ModelInfo;
      maxTokens?: number;
    };
    configured?: readonly string[];
  };
  /**
   * A scheduled job (0.7): nobody can answer. A call that would ask is denied with `reason`;
   * `onDeny` records it for the report. The job's approval list comes in `settings.allow`.
   */
  unattended?: { reason: string; onDeny?: (tool: string, target: CallTarget) => void };
  /**
   * The network allowlist (0.13, `settings.network`). `approved`: the list was approved elsewhere
   * (a job's approval, the eval command line), so no question. `home`: where trust.json is (tests).
   */
  network?: { approved?: boolean; home?: string };
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
  /**
   * Language plugins (0.16): user plugins from ~/.garuda/languages (`home` overrides the home
   * folder). Absent: the built-in experts only (tests, evals). Project plugins are not loaded.
   */
  languages?: { home?: string };
}

/** The output of a `!command` that goes to the model with the next message is cut here (0.6). */
export const USER_COMMAND_NOTE_CHARS = 10_000;

export class Runtime {
  readonly root: string;
  readonly modelState: ModelState;
  readonly undoCoordinator: UndoCoordinator;
  /** The detected formatters (0.10), on first use. */
  private formatters: Formatter[] | undefined;
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
  /** Team security policy (0.17). */
  private readonly policySourceList: string[];
  readonly policy: TeamPolicy | undefined;
  /** Structured audit logger (0.17). */
  readonly auditLogger: AuditLogger;
  private readonly permissions: PermissionEngine;
  private readonly store: SessionStore;
  private readonly tools: ToolRegistry;
  private readonly onEvent: ((event: AgentEvent) => void) | undefined;
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
  private skillList: Skill[] = [];
  private skillsHome = homedir();
  /** Hashes of project skills that the user allowed for this process. */
  private readonly allowedSkills = new Set<string>();
  /** Skill questions wait for each other: parallel read-only calls may load two at once. */
  private skillQueue: Promise<unknown> = Promise.resolve();
  private agentList: CustomAgent[] = [];
  /** --subagent-model: explore and agents without their own model use it. */
  private readonly subagentModelOption: RuntimeOptions["subagentModel"];
  /** Hashes of project agents that the user allowed for this process. */
  private readonly allowedAgents = new Set<string>();
  /** Model clients of agents, by spec. */
  private readonly agentModels = new Map<string, Promise<ChildModel>>();
  private hookRunner: HookRunner | undefined;
  private hooksStarted: Promise<void> | undefined;
  /** The network allowlist (0.13): the proxy, started before the first turn when settings ask. */
  private networkStarted: Promise<void> | undefined;
  private networkProxy: NetworkProxy | undefined;
  private networkOptions: NonNullable<RuntimeOptions["network"]> = {};
  /** The signal of the running turn: a proxy question stops with it. */
  private turnSignal: AbortSignal | undefined;
  /** The snapshot store for undo, or undefined when undo is off (0.4). */
  private snapshots: SnapshotStore | undefined;
  /** Claude's web search (0.6): the "claude" section of search.json, when web tools are on. */
  private readonly claudeSearchConfig: ClaudeSearchConfig | undefined;
  /** The user's answer for this session: asked before the first turn that could search. */
  private claudeSearch: "unasked" | "on" | "off" = "unasked";
  /** The last finished plan (0.7, /schedule). */
  private plan: PlanForJob | undefined;
  /** The first snapshot tree of each session, for /diff (0.6). */
  private readonly sessionBase = new Map<string, string>();
  /** Notes for the next turn, for example after an undo that kept the conversation. */
  private readonly pendingNotes: string[] = [];
  /** The prompt of the turn that runs or ran last (0.9: the note after a stopped turn). */
  private lastPrompt: string | undefined;
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
    policy?: TeamPolicy,
    auditLogger?: AuditLogger,
  ) {
    this.policy = policy;
    this.policySourceList = options.policySources ?? [];
    this.auditLogger =
      auditLogger ?? new AuditLogger(options.audit?.dir ?? options.root, { enabled: false });
    this.hookConfig = hookConfig;
    this.profiles = profiles;
    this.lspOptions = options.lsp ?? {};
    this.subagentModelOption = options.subagentModel;
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
    this.networkOptions = options.network ?? {};
    this.root = options.root;
    this.claudeSearchConfig = settings.web?.enabled === false ? undefined : options.search?.claude;
    this.store = options.store;
    this.onEvent = options.onEvent;
    this.system = system;
    this.knowledge = new KnowledgeIndex(options.root, {
      ...(options.languages === undefined ? {} : { home: options.languages.home ?? homedir() }),
    });
    this.codeIndex = settings.codeIndex ?? DEFAULT_CODE_INDEX_MODE;
    const web = settings.web ?? { enabled: true, allowLocalhost: false };
    this.tools = new ToolRegistry(
      defaultTools({
        codeIndex: this.codeIndex,
        ...(web.enabled ? { web: { allowLocalhost: web.allowLocalhost } } : {}),
        todo: settings.todo?.enabled === true,
        daemons: settings.daemons?.enabled === true,
      }),
    );
    const info = options.modelInfo ?? lookupModel(options.modelId);
    const start = settings.thinking;
    const initialThinking = fitThinking(
      {
        ...(start?.enabled === undefined ? {} : { enabled: start.enabled }),
        ...(start?.effort === undefined ? {} : { effort: start.effort }),
        ...(start?.show === undefined ? {} : { show: start.show }),
      },
      info.thinking,
    ).choice;
    this.modelState = new ModelState({
      modelId: options.modelId,
      model: options.model,
      limits: {
        maxSteps: settings.maxSteps ?? DEFAULT_MAX_STEPS,
        tokenBudget: settings.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
        contextWindow: settings.contextWindow ?? info.contextWindow,
      },
      price: settings.price ?? info.price,
      thinkingCaps: info.thinking,
      maxTokens: options.maxTokens,
      choices: options.models,
      settings,
      policy,
    });
    this.modelState.thinkingChoice = initialThinking;
    this.executor = choice.executor;
    this.executorNotice = choice.notice;
    this.undoCoordinator = new UndoCoordinator(
      this.snapshots,
      this.approver,
      this.executor.isolation,
      this.onNotice,
    );
    this.permissions = new PermissionEngine({
      root: options.root,
      settings,
      ...(policy === undefined ? {} : { policy }),
      auditLogger: this.auditLogger,
      approver: options.approver,
      isolation: this.executor.isolation,
      access: profileAccess(profiles),
      mode: () => this.turnMode,
      ...(options.unattended === undefined ? {} : { unattended: options.unattended }),
    });
    this.exploreModel = undefined;
    // Off by default: an A/B eval (hard suite, 3 runs per arm) showed no gain in steps or cost.
    if (settings.subagents?.enabled === true) {
      const sub = options.subagentModel;
      let subClient: ModelClient | undefined;
      const subPrice = sub === undefined ? this.price : sub.info.price;
      this.exploreModel = sub?.spec ?? options.modelId;
      // Without --subagent-model, explore keeps the start model: /models changes only the main one.
      const startModel = options.model;
      let startClient: Promise<ModelClient> | undefined;
      this.tools.register(
        createExploreTool({
          model: {
            spec: this.exploreModel,
            client:
              sub === undefined
                ? () => {
                    startClient ??= Promise.resolve(
                      typeof startModel === "function" ? startModel() : startModel,
                    );
                    return startClient;
                  }
                : async () => {
                    assertModelAllowedByPolicy(this.policy, sub.spec);
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
    // MoE only when the settings turn it on (merge gate): no measured gain yet, and it must not ride
    // along with subagents.enabled (that mixed it into the explore A/B results).
    if (settings.moe?.enabled === true) {
      const sub = options.subagentModel;
      let subClient: ModelClient | undefined;
      const subPrice = sub === undefined ? this.price : sub.info.price;
      const spec = sub?.spec ?? options.modelId;
      const startModel = options.model;
      let startClient: Promise<ModelClient> | undefined;

      this.tools.register(
        createMoeDispatchTool({
          mainTools: () => this.tools,
          model: async () => ({
            spec,
            client:
              sub === undefined
                ? () => {
                    startClient ??= Promise.resolve(
                      typeof startModel === "function" ? startModel() : startModel,
                    );
                    return startClient;
                  }
                : async () => {
                    assertModelAllowedByPolicy(this.policy, sub.spec);
                    subClient ??= await sub.model();
                    return subClient;
                  },
            contextWindow: sub?.info.contextWindow ?? this.limits.contextWindow,
            ...(subPrice === undefined ? {} : { price: subPrice }),
          }),
          permissions: this.permissions,
          knowledge: this.knowledge,
          hooks: () => this.hookRunner,
          executor: this.executor,
          journal: (childId) =>
            this.current === undefined ? undefined : this.store.openChild(this.current.id, childId),
          limits: {
            maxSteps:
              settings.moe?.maxSteps ??
              settings.subagents?.maxSteps ??
              DEFAULT_EXPLORE_LIMITS.maxSteps,
            tokenBudget:
              settings.moe?.tokenBudget ??
              settings.subagents?.tokenBudget ??
              DEFAULT_EXPLORE_LIMITS.tokenBudget,
          },
          profiles: this.profiles,
          serverTools: () =>
            this.claudeSearch === "on" && this.claudeSearchConfig !== undefined
              ? [this.claudeSearchSpec(this.claudeSearchConfig)]
              : [],
        }),
      );
    }
  }

  /** The notification settings for the chat (0.6); the CLI applies them. */
  get notificationSettings(): Settings["notifications"] {
    return this.settings.notifications;
  }

  /** The main model spec, as the session records it. */
  get modelId(): string {
    return this.modelState.modelId;
  }

  get limits(): RunLimits {
    return this.modelState.limits;
  }

  get price(): Price | undefined {
    return this.modelState.price;
  }

  /** The main model client, loaded on first use (N3). */
  private async client(): Promise<ModelClient> {
    return this.modelState.client();
  }

  static async create(options: RuntimeOptions): Promise<Runtime> {
    const policy = options.policy;
    const ignored = ignoredProjectPolicy(options.root);
    if (ignored !== undefined) {
      options.onNotice?.(
        `${ignored} is ignored: a team policy comes only from the managed file or ~/.garuda/policy.json, which a project cannot change.`,
      );
    }
    assertModelAllowedByPolicy(policy, options.modelId);
    // A new object: the loaded settings may be the shared DEFAULT_SETTINGS, or the caller's own
    // object. Changing either in place gave every later runtime in the process the policy's limits.
    const settings = withPolicyLimits(
      options.settings ?? (await loadSettings(options.root)),
      policy,
    );
    const auditLogger = new AuditLogger(options.audit?.dir ?? options.root, {
      ...(policy === undefined ? {} : { policy }),
      ...(options.audit === undefined ? { enabled: false } : {}),
      ...(options.onNotice === undefined ? {} : { onError: options.onNotice }),
    });
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
    let skills: Skill[] = [];
    if (options.skills !== undefined && settings.skills?.enabled !== false) {
      const loaded = await loadSkills({
        home: options.skills.home ?? homedir(),
        root: options.root,
        builtins: BUILTIN_COMMANDS,
      });
      skills = loaded.skills;
      for (const problem of loaded.problems) options.onNotice?.(problem);
    }
    let agents: CustomAgent[] = [];
    if (options.agents !== undefined && settings.agents?.enabled !== false) {
      const loaded = await loadAgents({
        home: options.agents.home ?? homedir(),
        root: options.root,
      });
      agents = loaded.agents;
      for (const problem of loaded.problems) options.onNotice?.(problem);
    }
    const system = buildSystemPrompt(
      options.root,
      await loadInstructions(options.root),
      await loadMemory(options.root),
      {
        codeIndex: settings.codeIndex ?? DEFAULT_CODE_INDEX_MODE,
        sandboxed: choice.executor.isolation !== "none",
        mcp: mcpServers.some((s) => s.def.enabled),
        web: settings.web?.enabled ?? true,
        search:
          (options.search?.config !== undefined || options.search?.claude !== undefined) &&
          settings.web?.enabled !== false,
        hooks: hookConfig.user.length + hookConfig.project.length > 0,
        languages: profileNotes(profiles),
        explore: settings.subagents?.enabled === true,
        moe: settings.moe?.enabled === true,
        todo: settings.todo?.enabled === true,
        lsp: options.lsp?.enabled ?? settings.lsp?.enabled === true,
        skills: skills.some((s) => s.modelInvocable),
        agents: agents.length > 0,
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
      policy,
      auditLogger,
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
    const searchConfig = options.search?.config;
    if (searchConfig !== undefined && settings.web?.enabled !== false) {
      runtime.tools.register(
        createWebSearchTool({
          config: searchConfig,
          ...(options.search?.fetch === undefined ? {} : { fetch: options.search.fetch }),
        }),
      );
    }
    runtime.skillList = skills;
    runtime.skillsHome = options.skills?.home ?? homedir();
    if (skills.some((s) => s.modelInvocable)) {
      runtime.tools.register(
        createSkillTool({
          skills,
          root: options.root,
          home: runtime.skillsHome,
          allow: (skill, signal) => runtime.allowSkill(skill, signal),
        }),
      );
    }
    runtime.agentList = agents;
    if (agents.length > 0) {
      runtime.tools.register(
        createAgentTool({
          agents,
          mainTools: () => runtime.tools,
          model: (agent) => runtime.agentModel(agent, options.agents?.resolveModel),
          permissions: runtime.permissions,
          knowledge: runtime.knowledge,
          hooks: () => runtime.hookRunner,
          executor: runtime.executor,
          journal: (childId) =>
            runtime.current === undefined
              ? undefined
              : runtime.store.openChild(runtime.current.id, childId),
          limits: {
            maxSteps: settings.subagents?.maxSteps ?? DEFAULT_EXPLORE_LIMITS.maxSteps,
            tokenBudget: settings.subagents?.tokenBudget ?? DEFAULT_EXPLORE_LIMITS.tokenBudget,
          },
          allow: (agent, tools, signal) => runtime.allowAgent(agent, tools, signal),
          serverTools: () =>
            runtime.claudeSearch === "on" && runtime.claudeSearchConfig !== undefined
              ? [runtime.claudeSearchSpec(runtime.claudeSearchConfig)]
              : [],
        }),
      );
    }
    if (options.resume !== undefined) {
      runtime.current = await resumeSession({
        store: options.store,
        root: options.root,
        start: runtime.startFields(),
        ...(options.resume === true ? {} : { sessionId: options.resume }),
      });
      runtime.adoptThinking(runtime.current);
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
  /** Custom agents (0.5), sorted by name. */
  get agents(): readonly CustomAgent[] {
    return this.agentList;
  }

  /**
   * May this agent run? User agents: yes. A project agent asks once (its instructions and tools),
   * pinned like skills. Questions share the skill queue: calls may run at the same time.
   */
  allowAgent(agent: CustomAgent, tools: readonly string[], signal: AbortSignal): Promise<boolean> {
    if (agent.source === "user" || this.allowedAgents.has(agent.hash)) return Promise.resolve(true);
    const next = this.skillQueue.then(async () => {
      if (this.allowedAgents.has(agent.hash)) return true;
      const trust = await TrustStore.open(this.skillsHome);
      const known = trust.agentHash(this.root, agent.name);
      if (known !== agent.hash) {
        const choice = await this.approver.ask(
          agentConsent(agent, tools, known !== undefined, this.executor.isolation),
          signal,
        );
        if (choice === "deny") return false;
        if (choice === "session") await trust.setAgentHash(this.root, agent.name, agent.hash);
      }
      this.allowedAgents.add(agent.hash);
      return true;
    });
    this.skillQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * The model of an agent: the agent's own (user agents: an id, or haiku/sonnet/opus/fable as in
   * Claude Code), else --subagent-model, else the main model.
   */
  private agentModel(
    agent: CustomAgent,
    resolve: NonNullable<RuntimeOptions["agents"]>["resolveModel"],
  ): Promise<ChildModel> {
    const main = (): ChildModel => {
      const sub = this.subagentModelOption;
      if (sub !== undefined) {
        assertModelAllowedByPolicy(this.policy, sub.spec);
        let client: Promise<ModelClient> | undefined;
        return {
          spec: sub.spec,
          client: () => {
            assertModelAllowedByPolicy(this.policy, sub.spec);
            client ??= sub.model();
            return client as Promise<ModelClient>;
          },
          contextWindow: sub.info.contextWindow,
          ...(sub.info.price === undefined ? {} : { price: sub.info.price }),
        };
      }
      return {
        spec: this.modelId,
        client: () => this.client(),
        contextWindow: this.limits.contextWindow,
        ...(this.price === undefined ? {} : { price: this.price }),
      };
    };
    if (agent.model === undefined) return Promise.resolve(main());
    const spec = aliasModel(agent.model) ?? agent.model;
    if (aliasModel(agent.model) !== undefined && this.modelId.includes("/")) {
      // An alias names a Claude model; with another provider, the main model does the work.
      return Promise.resolve(main());
    }
    assertModelAllowedByPolicy(this.policy, spec);
    let cached = this.agentModels.get(spec);
    if (cached === undefined) {
      cached = (async (): Promise<ChildModel> => {
        if (resolve === undefined) throw new Error(`Garuda cannot use the model "${spec}" here.`);
        const resolved = resolve(spec);
        assertModelAllowedByPolicy(this.policy, resolved.spec);
        let client: Promise<ModelClient> | undefined;
        return {
          spec: resolved.spec,
          client: () => {
            assertModelAllowedByPolicy(this.policy, resolved.spec);
            client ??= resolved.model();
            return client as Promise<ModelClient>;
          },
          contextWindow: resolved.info.contextWindow,
          ...(resolved.info.price === undefined ? {} : { price: resolved.info.price }),
        };
      })();
      this.agentModels.set(spec, cached);
    }
    return cached;
  }

  /**
   * `!command` in the chat (0.6): the user runs a command as the bash tool would, through the same
   * permission engine (deny rules; in the OS sandbox no question), hooks and executor. The output
   * goes to the user now, and with the next message to the model.
   */
  async runUserCommand(
    command: string,
    signal: AbortSignal,
  ): Promise<{ text: string; isError: boolean }> {
    const outcome = await this.tools.execute(
      { type: "tool_use", id: `user-${Date.now()}`, name: "bash", input: { command } },
      {
        root: this.root,
        signal,
        permissions: this.permissions,
        files: this.current?.files ?? new FileTracker(),
        executor: this.executor,
        ...(this.hookRunner === undefined ? {} : { hooks: this.hookRunner }),
      },
    );
    const output =
      outcome.content.length > USER_COMMAND_NOTE_CHARS
        ? `${outcome.content.slice(0, USER_COMMAND_NOTE_CHARS)}\n[… cut]`
        : outcome.content;
    this.pendingNotes.push(
      `The user ran a command in the chat (not you):\n$ ${neutralizeTags(command)}\n${neutralizeTags(output)}`,
    );
    return { text: outcome.content, isError: outcome.isError };
  }

  /** Skills (0.5), sorted by name. */
  get skills(): readonly Skill[] {
    return this.skillList;
  }

  /**
   * May this skill load? User skills: yes. A project skill asks once (its full text), and "Yes,
   * and remember" pins the hash of SKILL.md in ~/.garuda/trust.json, so a changed file asks again.
   */
  allowSkill(skill: Skill, signal: AbortSignal): Promise<boolean> {
    if (skill.source === "user" || this.allowedSkills.has(skill.hash)) return Promise.resolve(true);
    const next = this.skillQueue.then(() => this.askSkill(skill, signal));
    this.skillQueue = next.catch(() => undefined);
    return next;
  }

  private async askSkill(skill: Skill, signal: AbortSignal): Promise<boolean> {
    if (this.allowedSkills.has(skill.hash)) return true;
    const trust = await TrustStore.open(this.skillsHome);
    const known = trust.skillHash(this.root, skill.name);
    if (known !== skill.hash) {
      const choice = await this.approver.ask(
        skillConsent(skill, known !== undefined, this.executor.isolation),
        signal,
      );
      if (choice === "deny") return false;
      if (choice === "session") await trust.setSkillHash(this.root, skill.name, skill.hash);
    }
    this.allowedSkills.add(skill.hash);
    return true;
  }

  async resolveCommand(line: string, signal: AbortSignal): Promise<CommandResolution> {
    const parsed = parseCommandLine(line);
    // A skill wins over a custom command with the same name, as in Claude Code.
    const skill =
      parsed === undefined
        ? undefined
        : this.skillList.find((s) => s.name === parsed.name && s.userInvocable);
    if (parsed !== undefined && skill !== undefined) {
      if (!(await this.allowSkill(skill, signal))) {
        return { kind: "denied", message: `You did not allow the project skill "${skill.name}".` };
      }
      return { kind: "prompt", prompt: await skillText(skill, parsed.args, this), skill };
    }
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
    this.claudeSearch = "unasked";
  }

  /**
   * Claude's web search for the next request (0.6), or none: only with a "claude" section in
   * search.json, web tools on, a model client that can run it, and the user's yes for this session
   * (asked once). A "no" leaves the client web_search (Tavily …) as the fallback.
   */
  private async claudeSearchTools(signal: AbortSignal): Promise<ServerToolSpec[]> {
    const config = this.claudeSearchConfig;
    if (config === undefined) return [];
    const client = await this.client();
    if (client.serverTools?.includes("web_search") !== true) return [];
    if (this.claudeSearch === "unasked") {
      const fallback = this.tools.get("web_search") !== undefined;
      const choice = await this.approver.ask(
        {
          tool: "web_search",
          target: { kind: "input", json: "" },
          preview: [
            `The model can search the web with Claude's own search tool, on Anthropic's servers: up to ${config.maxUses} searches per request, $10 per 1,000 searches.`,
            "Garuda cannot ask before each query: the model sends them inside its reply.",
            ...(config.allowedDomains === undefined
              ? []
              : [`Only these domains: ${config.allowedDomains.join(", ")}.`]),
            ...(config.blockedDomains === undefined
              ? []
              : [`Never these domains: ${config.blockedDomains.join(", ")}.`]),
            fallback
              ? "If you say no, web_search uses your other provider and asks for each query."
              : "If you say no, there is no web search in this session.",
          ].join("\n"),
          isolation: this.executor.isolation,
          title: "Claude's web search",
          question: "Allow Claude's web search in this session?",
          choices: ["session", "deny"],
          labels: { session: "Yes, for this session", deny: "No, not in this session" },
        },
        signal,
      );
      this.claudeSearch = choice === "deny" ? "off" : "on";
    }
    return this.claudeSearch === "on" ? [this.claudeSearchSpec(config)] : [];
  }

  private claudeSearchSpec(config: ClaudeSearchConfig): ServerToolSpec {
    return {
      type: "web_search",
      maxUses: config.maxUses,
      ...(config.allowedDomains === undefined ? {} : { allowedDomains: config.allowedDomains }),
      ...(config.blockedDomains === undefined ? {} : { blockedDomains: config.blockedDomains }),
    };
  }

  /** The sessions of this project for /sessions (0.6), newest first, at most `max`. */
  async listSessions(max = 20): Promise<{ sessions: SessionSummary[]; total: number }> {
    return listSessions(this.store, max);
  }

  /**
   * Continue another session of this project in the chat (0.6, /sessions <n|id>), as --resume
   * does. `ref` is a number from the /sessions list or a session id (or its unique start).
   */
  async switchSession(ref: string): Promise<{ ok: boolean; text: string }> {
    const id = await this.findSession(ref);
    if (id === undefined) {
      return { ok: false, text: `There is no session "${ref}" in this project. Type /sessions.` };
    }
    if (id === this.current?.id) return { ok: true, text: `Session ${id} is already open.` };
    try {
      this.current = await resumeSession({
        store: this.store,
        root: this.root,
        sessionId: id,
        start: this.startFields(),
      });
    } catch (error) {
      return { ok: false, text: (error as Error).message };
    }
    this.adoptThinking(this.current);
    // Notes and approvals for the old session do not carry over; the process-wide ones do.
    this.pendingNotes.length = 0;
    this.claudeSearch = "unasked";
    const s = this.current;
    return {
      ok: true,
      text: `Continuing session ${id} (${s.messages.length} messages, ${Math.round((s.contextTokens / this.limits.contextWindow) * 100)}% of the context window). Read files again before you edit them.`,
    };
  }

  /** A number from the /sessions list, a session id, or the unique start of one. */
  private async findSession(ref: string): Promise<string | undefined> {
    return findSession(ref, this.store);
  }

  /** /sessions rename <n|id> <title> (0.8). */
  async renameSession(ref: string, title: string): Promise<{ ok: boolean; text: string }> {
    return renameSession(ref, title, this.store);
  }

  /**
   * /sessions delete <n|id> (0.8): ask, then delete the session file and its subagent journals.
   * The open session cannot go.
   */
  async deleteSession(ref: string, signal: AbortSignal): Promise<{ ok: boolean; text: string }> {
    return deleteSession(
      ref,
      signal,
      this.store,
      this.current?.id,
      this.approver,
      this.executor.isolation,
    );
  }

  /** The records of the current session, for /export (0.6). Redacted as on disk. */
  /**
   * The output limit for a turn (0.12). A model that always thinks (the 5-series) spends its
   * thinking from max_tokens, so it gets the room that /thinking gives, also by default: with 8,192
   * a repo eval task stopped at max_tokens after thinking alone.
   */
  private outputTokens(): { maxTokens?: number } {
    if (this.modelState.thinkingCaps?.mode === "always") {
      return {
        maxTokens: thinkingMaxTokens(
          this.modelState.maxTokens ?? DEFAULT_MAX_TOKENS,
          this.thinkingParams ?? {},
        ),
      };
    }
    return this.modelState.maxTokens === undefined ? {} : { maxTokens: this.modelState.maxTokens };
  }

  async sessionRecords(): Promise<SessionRecord[] | undefined> {
    return this.current === undefined ? undefined : this.store.read(this.current.id);
  }

  /**
   * The models for /models (0.6): the known Claude models, then the user's from
   * ~/.garuda/models.json. The main model is in the list, also when it is in neither.
   */
  modelList(): { spec: string; info: ModelInfo }[] {
    return this.modelState.modelList();
  }

  /**
   * Switch the main model for the next turns of this chat (0.6, /models <n|spec|alias>). The
   * session records the change; new chats start with -m or GARUDA_MODEL again. Explore keeps the
   * start model. The prompt cache of the old model does not carry over.
   */
  async setModel(ref: string): Promise<{ ok: boolean; text: string }> {
    return this.modelState.setModel(ref, this.current, () => this.startFields());
  }

  /** Run one turn: the user's prompt, then the loop until it stops. */
  async runTurn(prompt: string, signal: AbortSignal): Promise<AgentResult> {
    this.lastPrompt = prompt;
    this.turnSignal = signal;
    await this.startHooks(signal);
    await this.startNetwork(signal);
    await this.startMcp(signal);
    const session = this.ensureSession();
    this.auditLogger.setSessionId(session.id);
    this.turnMode = this.selectedMode;
    // jdtls imports a Maven or Gradle project for a while: start it now, not at the first edit.
    if (this.lspEnabled && this.profiles.some((p) => p.id === "maven" || p.id === "gradle")) {
      void this.lsp().then((m) => m.warm("java"));
    }
    await this.snapshot(session, prompt, signal);
    const serverTools = await this.claudeSearchTools(signal);
    const notes = [...this.pendingNotes.splice(0), ...(this.mcp?.takeNotes() ?? [])];
    if (this.turnMode === "plan") notes.unshift(PLAN_NOTE);
    // @path in the prompt (0.6): the files go with the message and count as read.
    const mentions = await attachMentions(prompt, this.root, session.files);
    const lines = [
      ...mentions.attachments.map((a) => `Attached ${a.summary}.`),
      ...mentions.skipped.map((s) => `Not attached: ${s}.`),
    ];
    if (lines.length > 0) this.onEvent?.({ type: "notice", text: lines.join("\n") });
    addUserMessage(
      session,
      prompt,
      notes,
      mentions.attachments.map((a) => a.text),
    );
    const result = await runAgent(session, {
      model: await this.client(),
      tools: this.tools,
      system: this.system,
      permissions: this.permissions,
      executor: this.executor,
      knowledge: this.knowledge,
      audit: this.auditLogger,
      ...(this.hookRunner === undefined ? {} : { hooks: this.hookRunner }),
      ...(serverTools.length === 0 ? {} : { serverTools }),
      ...(this.lspEnabled
        ? {
            diagnostics: async (absolute: string, shown: string, text: string, s: AbortSignal) =>
              (await this.lsp()).diagnostics(absolute, shown, text, s),
          }
        : {}),
      ...(this.formatSource === undefined ? {} : { format: this.formatSource }),
      maxSteps: this.limits.maxSteps,
      tokenBudget: this.limits.tokenBudget,
      ...this.outputTokens(),
      contextWindow: this.limits.contextWindow,
      ...(this.price === undefined ? {} : { price: this.price }),
      ...(this.onEvent === undefined ? {} : { onEvent: this.onEvent }),
      ...(this.settings.thinking?.keepBlocks === false ? { keepThinking: false } : {}),
      ...(this.thinkingParams === undefined ? {} : { thinking: this.thinkingParams }),
      signal,
    });
    // A finished plan (0.7): /schedule turns it into a job.
    if (this.turnMode === "plan" && result.stopReason === "done") {
      const plan = lastAssistantText(session.messages);
      if (plan !== "") this.plan = { request: prompt, plan, sessionId: session.id };
    }
    return result;
  }

  /** The last finished plan of this process, for /schedule (0.7). */
  get lastPlan(): PlanForJob | undefined {
    return this.plan;
  }

  /**
   * /schedule [HH:MM] (0.7): the last plan becomes a job with its own approval list (from the
   * plan's permissions block). It asks once; `garuda run <id>` runs it.
   */
  async scheduleJob(
    at: string | undefined,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; text: string }> {
    const plan = this.plan;
    if (plan === undefined) {
      return {
        ok: false,
        text: "There is no finished plan in this chat. Make one in plan mode (/plan), then type /schedule.",
      };
    }
    const { createJob } = await import("../jobs/create.js");
    const created = await createJob({
      root: this.root,
      executor: this.executor,
      approver: this.approver,
      plan,
      modelId: this.modelId,
      // Claude models (no provider prefix, or "anthropic/") can use the Batch API.
      batchCapable: !this.modelId.includes("/") || this.modelId.startsWith("anthropic/"),
      ...(at === undefined ? {} : { at }),
      // The chat offers a launchd agent on macOS (a second question).
      launchd: {},
      ...testOption(detectTestCommand(this.root, this.profiles)),
      ...(this.networkAllowlist().length === 0 ? {} : { network: this.networkAllowlist() }),
      signal,
    });
    return { ok: created.ok, text: created.text };
  }

  /**
   * Run a check command (0.11: a job's tests) in the sandbox with the policy of bash, outside the
   * permission engine: Garuda runs it, not the model. The output is not a note for the model.
   */
  async runCheck(command: string, timeoutMs: number, signal: AbortSignal): Promise<TestRun> {
    const result = await this.executor.run(command, this.permissions.execPolicy(timeoutMs), {
      signal,
    });
    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      tail: tail(`${result.stdout.text}\n${result.stderr.text}`),
    };
  }

  /**
   * One model request with no tools (0.11: the job's review): the main model, its price. It does
   * not touch the session.
   */
  async askModel(
    system: string,
    text: string,
    signal: AbortSignal,
  ): Promise<{ text: string; costUsd?: number }> {
    const model = await this.client();
    let response: ModelResponse | undefined;
    for await (const event of model.stream(
      {
        system,
        messages: [{ role: "user", content: [{ type: "text", text }] }],
        tools: [],
        maxTokens: 8_192,
      },
      { signal },
    )) {
      if (event.type === "response") response = event.response;
    }
    if (response === undefined) throw new Error("The model gave no answer.");
    const answer = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    const price = this.price;
    return price === undefined
      ? { text: answer }
      : { text: answer, costUsd: responseCost(response, price) };
  }

  /**
   * /jobs cancel <id> (0.7): a scheduled job does not run: its launchd agent goes, and its status
   * becomes "stopped". A job that ran keeps its status and report.
   */
  async cancelJob(
    id: string,
    /** For tests: the agent's home and the executor for launchctl. */
    agent: { env?: import("../jobs/launchd.js").AgentEnv; executor?: Executor } = {},
  ): Promise<string> {
    const { loadJob, saveJob } = await import("../jobs/job.js");
    const { defaultAgentEnv, nightSpec, removeAgent, removeSpec } = await import(
      "../jobs/launchd.js"
    );
    // /jobs cancel night (0.11): the queue's launchd agent goes; the queue stays.
    if (id === "night") {
      const removed = await removeSpec(
        agent.executor ?? this.executor,
        nightSpec(this.root),
        agent.env ?? defaultAgentEnv(),
      );
      return removed
        ? "The night queue's launchd agent is removed. The queue stays: garuda night runs it."
        : "The night queue has no launchd agent.";
    }
    let job: Awaited<ReturnType<typeof loadJob>>;
    try {
      job = await loadJob(this.root, id);
    } catch (error) {
      return (error as Error).message;
    }
    if (job.status !== "scheduled")
      return `Job ${id} is ${job.status}: there is nothing to cancel.`;
    const hadAgent = job.launchd !== undefined;
    if (hadAgent) {
      await removeAgent(agent.executor ?? this.executor, job, agent.env ?? defaultAgentEnv());
    }
    delete job.launchd;
    job.status = "stopped";
    await saveJob(job);
    return `Job ${id} is cancelled${hadAgent ? " and its launchd agent is removed" : ""}. \`garuda run ${id}\` can still run it.`;
  }

  /**
   * /jobs delete <id> (0.11): ask, then remove the job file, report, log and worktree, and the
   * branch when the user says so (an unmerged branch may hold work). A running job cannot go.
   */
  async deleteJob(
    id: string,
    signal: AbortSignal,
    /** For tests: the agent's home and the executor for launchctl. */
    agent: { env?: import("../jobs/launchd.js").AgentEnv; executor?: Executor } = {},
  ): Promise<string> {
    const { loadJob } = await import("../jobs/job.js");
    const { defaultAgentEnv, removeAgent } = await import("../jobs/launchd.js");
    const { jobLeftovers, removeJob } = await import("../jobs/remove.js");
    let job: Awaited<ReturnType<typeof loadJob>>;
    try {
      job = await loadJob(this.root, id);
    } catch (error) {
      return (error as Error).message;
    }
    if (job.status === "running") {
      return `Job ${id} is running. Stop it first (Ctrl-C in its terminal), or set "status" to "stopped" in its file if no garuda runs it.`;
    }
    const executor = agent.executor ?? this.executor;
    const left = await jobLeftovers(executor, job);
    const unmerged = left.branch && !left.merged;
    const choice = await this.approver.ask(
      {
        tool: "jobs",
        target: { kind: "input", json: "{}" },
        preview: [
          `Job ${id}: ${job.title} (${job.status})`,
          `Goes: the job file, report and log${left.worktree ? ", its worktree" : ""}${job.launchd === undefined ? "" : ", its launchd agent"}.`,
          !left.branch
            ? "It has no branch."
            : unmerged
              ? `Its branch ${job.branch} is NOT merged: it may hold work. Keep it, or delete it too.`
              : `Its branch ${job.branch} is merged: deleting it loses nothing.`,
        ].join("\n"),
        isolation: this.executor.isolation,
        title: "Delete a job?",
        question: "Delete it?",
        ...(unmerged
          ? {
              choices: ["once", "session", "deny"] as const,
              labels: {
                once: "Yes, and delete the branch too",
                session: "Yes, but keep the branch",
                deny: "No",
              },
            }
          : {
              choices: ["once", "deny"] as const,
              labels: { once: "Yes, delete it", deny: "No" },
            }),
      },
      signal,
    );
    if (choice === "deny") return "Nothing changed.";
    if (job.launchd !== undefined) {
      await removeAgent(executor, job, agent.env ?? defaultAgentEnv());
    }
    const gone = await removeJob(executor, job, left, choice === "once");
    const kept = left.branch && choice !== "once" ? ` The branch ${job.branch} stays.` : "";
    return `Job ${id} is deleted: ${gone.join(", ")}.${kept}`;
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
    if (this.claudeSearchConfig !== undefined) {
      out.push(
        this.tools.get("web_search") === undefined
          ? "web_search: Claude"
          : "web_search: Claude + fallback",
      );
    } else if (this.tools.get("web_search") !== undefined) out.push("web_search");
    if (this.codeIndex !== "off") out.push(`code index: ${this.codeIndex}`);
    if (this.selectedMode === "plan") out.push("plan mode");
    if (this.lspEnabled) out.push("LSP");
    if (this.agentList.length > 0)
      out.push(`${this.agentList.length} agent${this.agentList.length === 1 ? "" : "s"}`);
    if (this.skillList.length > 0)
      out.push(`${this.skillList.length} skill${this.skillList.length === 1 ? "" : "s"}`);
    if (this.exploreModel !== undefined)
      out.push(this.exploreModel === this.modelId ? "explore" : `explore: ${this.exploreModel}`);
    if (this.tools.get("delegate_expert") !== undefined) out.push("5 experts");
    return out;
  }

  /** Available subagents summary, for the start banner and /session. */
  subagentsSummary(): string[] {
    const out: string[] = [];
    if (this.exploreModel !== undefined) {
      out.push(this.exploreModel === this.modelId ? "explore" : `explore: ${this.exploreModel}`);
    }
    if (this.tools.get("delegate_expert") !== undefined) {
      out.push("5 MoE experts (Go, Rust, Python, Java, TS)");
    }
    return out;
  }

  /** Custom agents summary, for the start banner and /session. */
  agentsSummary(): string[] {
    if (this.agentList.length === 0) return [];
    if (this.agentList.length === 1 && this.agentList[0] !== undefined) {
      return [`1 agent (${this.agentList[0].name})`];
    }
    const names = this.agentList
      .slice(0, 3)
      .map((a) => a.name)
      .join(", ");
    const more = this.agentList.length > 3 ? "…" : "";
    return [`${this.agentList.length} agents (${names}${more})`];
  }

  /** Skills summary, for the start banner and /session. */
  skillsSummary(): string[] {
    if (this.skillList.length === 0) return [];
    if (this.skillList.length === 1 && this.skillList[0] !== undefined) {
      return [`1 skill (${this.skillList[0].name})`];
    }
    const names = this.skillList
      .slice(0, 3)
      .map((s) => s.name)
      .join(", ");
    const more = this.skillList.length > 3 ? "…" : "";
    return [`${this.skillList.length} skills (${names}${more})`];
  }

  /** Tools and integrations summary, for the start banner and /session. */
  toolsSummary(): string[] {
    const out: string[] = this.profiles.map((p) => p.label);
    const servers = this.mcpServers.filter((s) => s.def.enabled).length;
    if (servers > 0) out.push(`${servers} MCP server${servers === 1 ? "" : "s"}`);
    const hooks = this.hookConfig.user.length + this.hookConfig.project.length;
    if (hooks > 0) out.push(`${hooks} hook${hooks === 1 ? "" : "s"}`);
    if (this.tools.get("web_fetch") !== undefined) out.push("web_fetch");
    if (this.claudeSearchConfig !== undefined) {
      out.push(
        this.tools.get("web_search") === undefined
          ? "web_search: Claude"
          : "web_search: Claude + fallback",
      );
    } else if (this.tools.get("web_search") !== undefined) out.push("web_search");
    if (this.codeIndex !== "off") out.push(`code index: ${this.codeIndex}`);
    if (this.lspEnabled) out.push("LSP");
    if (this.selectedMode === "plan") out.push("plan mode");
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
    // Background processes end with the runtime (merge gate): a running daemon kept `garuda -p`
    // and jobs from exiting, because its pipes held Node's event loop.
    this.executor.daemons?.shutdown();
    await Promise.all([this.mcp?.close(), this.lspManager?.close(), this.networkProxy?.close()]);
  }

  /** The network allowlist in effect (0.13): the settings entries, or [] when the proxy is off. */
  networkAllowlist(): string[] {
    return this.networkProxy === undefined ? [] : [...(this.settings.network?.allow ?? [])];
  }

  /**
   * The network allowlist (0.13), once, before the first turn. Only with the OS sandbox: without
   * it every command asks and runs with the full network anyway. A project list runs only after
   * the user saw it and agreed; the answer can be pinned to a hash of the list.
   */
  private async startNetwork(signal: AbortSignal): Promise<void> {
    const entries = this.settings.network?.allow ?? [];
    if (entries.length === 0 || this.executor.isolation !== "os") return;
    this.networkStarted ??= (async () => {
      if (this.networkOptions.approved !== true) {
        const trust = await TrustStore.open(this.networkOptions.home ?? homedir());
        const hash = networkHash(entries);
        const known = trust.networkHash(this.root);
        if (known !== hash) {
          const choice = await this.approver.ask(
            networkConsent(entries, this.executor.isolation, known !== undefined),
            signal,
          );
          if (choice === "deny") {
            this.onNotice?.("Network for commands: off (you said no). Commands have no network.");
            return;
          }
          if (choice === "session") await trust.setNetworkHash(this.root, hash);
        }
      }
      let bridge: string | undefined;
      if (this.executor.name === "bwrap") {
        bridge = nodeBinary();
        if (bridge === undefined) {
          this.onNotice?.(
            "Network for commands: off. On Linux the allowlist needs node on the PATH (for the bridge into the sandbox).",
          );
          return;
        }
      }
      const hosts = expandAllowlist(entries).hosts;
      // N3: the proxy (node:http) loads only for a project that uses the allowlist.
      const { NetworkProxy } = await import("../net/proxy.js");
      const proxy = new NetworkProxy({
        decide: (host, port) => this.networkDecision(hosts, host, port),
      });
      const started = await proxy.start();
      this.networkProxy = proxy;
      this.permissions.setNetwork({
        policy: { ...started, ...(bridge === undefined ? {} : { bridge }) },
        takeBlocked: () => proxy.takeBlocked(),
      });
      this.onNotice?.(
        `Network for commands: ${entries.join(", ")}, through Garuda's proxy. Other hosts ask.`,
      );
      // Live test (0.13): the model ran `npm view` outside the sandbox at once, because the tool
      // text says the sandbox has no network. Tell it which hosts work in the sandbox.
      this.pendingNotes.push(networkNote(entries));
    })();
    try {
      await this.networkStarted;
    } catch (error) {
      this.networkStarted = undefined;
      throw error;
    }
  }

  /** A host outside the list goes through the permission engine: rules, session answers, a question. */
  private async networkDecision(
    hosts: readonly string[],
    host: string,
    port: number,
  ): Promise<ProxyDecision> {
    if (!NETWORK_PORTS.includes(port)) {
      return { allowed: false, reason: `only ports ${NETWORK_PORTS.join(" and ")}` };
    }
    if (hostAllowed(host, hosts)) return { allowed: true };
    const decision = await this.permissions.check(
      {
        tool: "network",
        readOnly: false,
        info: {
          target: { kind: "url", url: `https://${host}`, host },
          preview: `A command in the sandbox wants to reach ${host}:${port} through Garuda's proxy. The host is not on the network allowlist ("network.allow" in .garuda/settings.json).`,
          title: `Let a command reach ${host}?`,
        },
      },
      this.turnSignal ?? new AbortController().signal,
    );
    return decision.allowed
      ? { allowed: true }
      : { allowed: false, reason: decision.reason.replace(/\.$/, "") };
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

  /**
   * /diff (0.6): the file changes since the first turn of this session ("session") or since the
   * start of the last turn ("last"), up to now, from the undo snapshots. Now includes changes the
   * user made outside Garuda. `path` limits the diff to one file or folder in the root.
   */
  async diff(
    scope: "session" | "last",
    path: string | undefined,
    signal: AbortSignal,
  ): Promise<{ files: FileStat[]; patch: string; path?: string } | { problem: string }> {
    const store = this.undoCoordinator.store;
    if (store === undefined) {
      return {
        problem:
          "/diff needs the undo snapshots, and they are off for this session (see /help or the undo setting).",
      };
    }
    const session = this.current;
    if (session === undefined) return { problem: "No turn has run in this session yet." };
    let base: string | undefined;
    if (scope === "last") base = session.undo.points.at(-1)?.tree;
    else {
      base = this.sessionBase.get(session.id);
      if (base === undefined) {
        const records = await this.store.read(session.id);
        base = records.find((r) => r.type === "snapshot")?.tree;
        if (base !== undefined) this.sessionBase.set(session.id, base);
      }
    }
    if (base === undefined) return { problem: "No turn has run in this session yet." };
    let shown: string | undefined;
    if (path !== undefined) {
      try {
        shown = displayPath(this.root, await resolveInRoot(this.root, path));
      } catch (error) {
        if (error instanceof PathOutsideRootError) {
          return { problem: `${path} is outside the working folder.` };
        }
        throw error;
      }
    }
    try {
      const now = await store.take(signal);
      const all = await store.stats(base, now, signal);
      const files =
        shown === undefined || shown === "."
          ? all
          : all.filter((f) => f.path === shown || f.path.startsWith(`${shown}/`));
      const patch =
        files.length === 0
          ? ""
          : await store.patch(base, now, shown === "." ? undefined : shown, signal);
      return { files, patch, ...(shown === undefined ? {} : { path: shown }) };
    } catch (error) {
      if (!(error instanceof SnapshotError)) throw error;
      return { problem: `/diff failed: ${error.message}` };
    }
  }

  /** True when turns get snapshots (0.4). */
  get undoEnabled(): boolean {
    return this.undoCoordinator.enabled;
  }

  /** Snapshot the files before a turn. A failure turns undo off with a notice; the turn goes on. */
  private async snapshot(session: Session, prompt: string, signal: AbortSignal): Promise<void> {
    return this.undoCoordinator.snapshot(session, prompt, signal);
  }

  /**
   * The project's formatter after edits (0.10): on with `formatters.enabled`, and only in the OS
   * sandbox (a formatter is a project command, like the model's bash). Detected on first use.
   */
  private get formatSource(): FormatSource | undefined {
    const config = this.settings.formatters;
    if (config?.enabled !== true || this.executor.isolation === "none") return undefined;
    return async (absolute, signal) => {
      this.formatters ??= detectFormatters(this.root, process.env.PATH, config.commands);
      const formatter = formatterFor(this.formatters, absolute);
      if (formatter === undefined) return undefined;
      const result = await this.executor.run(
        formatCommand(formatter, absolute),
        this.permissions.execPolicy(FORMAT_TIMEOUT_MS),
        { signal },
      );
      if (result.timedOut) return { name: formatter.name, problem: "it took too long" };
      if (result.exitCode !== 0) {
        const first = (result.stderr.text || result.stdout.text).trim().split("\n")[0] ?? "";
        return {
          name: formatter.name,
          problem: `exit code ${result.exitCode}${first === "" ? "" : `: ${first.slice(0, 200)}`}`,
        };
      }
      return { name: formatter.name, text: await readFile(absolute, "utf8") };
    };
  }

  /** The request fields for /thinking (0.9); undefined: the model's defaults. */
  private get thinkingParams(): ThinkingRequest | undefined {
    return this.modelState.thinkingParams;
  }

  /** /thinking (0.9): the state line. */
  thinkingStatus(): string {
    return this.modelState.thinkingStatus();
  }

  /** /thinking <word> (0.9): change the choice for this chat; the session records it. */
  setThinking(word: string): { ok: boolean; text: string } {
    return this.modelState.setThinking(word, this.current);
  }

  /** A resumed session brings its last /thinking choice (0.9), as far as this model allows. */
  private adoptThinking(session: Session): void {
    this.modelState.adoptThinking(session);
  }

  /**
   * /compact [focus] (0.8): summarise the older turns now; the last steps stay in full. Undefined
   * when there is no session or too little to compact.
   */
  async compact(
    focus: string | undefined,
    signal: AbortSignal,
  ): Promise<(CompactionResult & { costUsd?: number }) | undefined> {
    const session = this.current;
    if (session === undefined) return undefined;
    const model = await this.client();
    const price = this.price;
    let costUsd: number | undefined;
    const result = await compactNow(
      session,
      model,
      {
        ...(focus === undefined || focus === "" ? {} : { focus }),
        costOf: (response) => {
          costUsd = price === undefined ? undefined : responseCost(response, price);
          return costUsd;
        },
      },
      signal,
    );
    if (result === undefined) return undefined;
    return costUsd === undefined ? result : { ...result, costUsd };
  }

  /**
   * /undo (0.4): show what the last turn changed, ask, then restore the files and take the turn out
   * of the conversation. Returns the text for the user.
   */
  async undo(signal: AbortSignal): Promise<string> {
    return this.undoCoordinator.undo(this.current, this.pendingNotes, signal);
  }

  /** /redo (0.4): bring back the last undone turn: its files and its messages. */
  async redo(signal: AbortSignal): Promise<string> {
    return this.undoCoordinator.redo(this.current, this.pendingNotes, signal);
  }

  /** Record a turn that ended with no result: Ctrl-C ("interrupted") or an error. */
  recordStop(reason: "interrupted" | "error"): void {
    this.current?.journal?.write({ type: "end", stopReason: reason, steps: 0 });
    // Live test (0.9): after Ctrl-C the model went on with the stopped task at the next message.
    if (reason === "interrupted" && this.lastPrompt !== undefined) {
      const task =
        this.lastPrompt.length > 200 ? `${this.lastPrompt.slice(0, 199)}…` : this.lastPrompt;
      this.pendingNotes.push(
        `The user stopped the previous task ("${task}") before it finished. Do not go on with it unless the user asks; work on the new message. Files may have changed in part: read them again before you edit them.`,
      );
    }
  }

  get teamPolicy(): TeamPolicy | undefined {
    return this.policy;
  }

  /** The files of the team policy (managed first). */
  get teamPolicySources(): readonly string[] {
    return this.policySourceList;
  }

  get audit(): AuditLogger {
    return this.auditLogger;
  }

  private ensureSession(): Session {
    if (this.current !== undefined) return this.current;
    const id = newSessionId();
    this.auditLogger.setSessionId(id);
    const session = createSession(this.root, id, this.store.open(id));
    session.journal?.write({ type: "start", sessionId: id, ...this.startFields() });
    // A /thinking choice carries into a new session (0.9); the record lets a resume find it.
    if (Object.keys(this.modelState.thinkingChoice).length > 0) {
      session.journal?.write({ type: "thinking", choice: this.modelState.thinkingChoice });
    }
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

/** The text of the last assistant message that has text: the plan of a plan-mode turn. */
function lastAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const text = message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    if (text !== "") return text;
  }
  return "";
}

/** `{ test }` when there is a test command (exactOptionalPropertyTypes). */
function testOption(test: string | undefined): { test?: string } {
  return test === undefined ? {} : { test };
}
