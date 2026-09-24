import { buildSystemPrompt, loadInstructions, loadMemory } from "../context/instructions.js";
import { KnowledgeIndex } from "../knowledge/index.js";
import { type CodeIndexMode, DEFAULT_CODE_INDEX_MODE } from "../knowledge/mode.js";
import {
  type AgentEvent,
  type AgentResult,
  DEFAULT_MAX_STEPS,
  DEFAULT_TOKEN_BUDGET,
  runAgent,
} from "../loop/runAgent.js";
import { lookupModel, type Price } from "../model/pricing.js";
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
import { defaultTools } from "../tools/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { VERSION } from "../version.js";

/**
 * Everything one Garuda process needs to run turns: settings, executor, permissions,
 * the session and its store. The CLI (one-shot and chat) and the eval runner share it.
 * It never imports the CLI.
 */
export interface RuntimeOptions {
  root: string;
  modelId: string;
  /** The model client, or a function that loads it on first use (keeps startup fast, N3). */
  model: ModelClient | (() => Promise<ModelClient>);
  approver: Approver;
  store: SessionStore;
  /** Resume the latest session (true) or a given one. */
  resume?: true | string;
  /** Default: read .garuda/settings.json in the root. */
  settings?: Settings;
  onEvent?: (event: AgentEvent) => void;
}

export class Runtime {
  readonly root: string;
  readonly modelId: string;
  readonly limits: RunLimits;
  readonly price: Price | undefined;
  readonly executor: Executor;
  /** Set when "auto" found no OS sandbox. The CLI shows it once. */
  readonly executorNotice: string | undefined;
  readonly system: string;
  /** The local code index. It loads its language experts on first use. */
  readonly knowledge: KnowledgeIndex;
  /** Which code index tools the model gets. */
  readonly codeIndex: CodeIndexMode;
  private readonly permissions: PermissionEngine;
  private readonly store: SessionStore;
  private readonly tools: ToolRegistry;
  private readonly onEvent: ((event: AgentEvent) => void) | undefined;
  private model: ModelClient | (() => Promise<ModelClient>);
  private current: Session | undefined;

  private constructor(
    options: RuntimeOptions,
    settings: Settings,
    system: string,
    choice: ExecutorChoice,
  ) {
    this.root = options.root;
    this.modelId = options.modelId;
    this.model = options.model;
    this.store = options.store;
    this.onEvent = options.onEvent;
    this.system = system;
    this.knowledge = new KnowledgeIndex(options.root);
    this.codeIndex = settings.codeIndex ?? DEFAULT_CODE_INDEX_MODE;
    this.tools = new ToolRegistry(defaultTools({ codeIndex: this.codeIndex }));
    const info = lookupModel(options.modelId);
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
    });
  }

  static async create(options: RuntimeOptions): Promise<Runtime> {
    const settings = options.settings ?? (await loadSettings(options.root));
    const choice = createExecutor(settings.executor);
    const system = buildSystemPrompt(
      options.root,
      await loadInstructions(options.root),
      await loadMemory(options.root),
      {
        codeIndex: settings.codeIndex ?? DEFAULT_CODE_INDEX_MODE,
        sandboxed: choice.executor.isolation !== "none",
      },
    );
    const runtime = new Runtime(options, settings, system, choice);
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
    const session = this.ensureSession();
    addUserMessage(session, prompt);
    if (typeof this.model === "function") this.model = await this.model();
    return runAgent(session, {
      model: this.model,
      tools: this.tools,
      system: this.system,
      permissions: this.permissions,
      executor: this.executor,
      knowledge: this.knowledge,
      maxSteps: this.limits.maxSteps,
      tokenBudget: this.limits.tokenBudget,
      contextWindow: this.limits.contextWindow,
      ...(this.price === undefined ? {} : { price: this.price }),
      ...(this.onEvent === undefined ? {} : { onEvent: this.onEvent }),
      signal,
    });
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
