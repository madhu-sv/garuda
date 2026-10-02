import { COMPACTION_DEFAULTS } from "../context/compact.js";
import {
  aliasModel,
  knownModels,
  lookupModel,
  type ModelInfo,
  type Price,
} from "../model/pricing.js";
import {
  changeThinking,
  fitThinking,
  type ThinkingCaps,
  type ThinkingChoice,
  thinkingRequest,
  thinkingText,
  withoutThinking,
} from "../model/thinking.js";
import type { ModelClient, ThinkingRequest } from "../model/types.js";
import { assertModelAllowedByPolicy, type TeamPolicy } from "../permissions/policy.js";
import type { Settings } from "../permissions/settings.js";
import type { RunLimits, StartRecord } from "../session/records.js";
import type { Session } from "../session/session.js";

/** "1.0M context, $4/$20 per M tokens" for /models. */
export function modelFacts(contextWindow: number, price: Price | undefined): string {
  const window =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1_000)}k`;
  const cost =
    price === undefined
      ? "price unknown"
      : price.input === 0 && price.output === 0
        ? "free"
        : `$${price.input}/$${price.output} per M tokens`;
  return `${window} context, ${cost}`;
}

export interface ModelChoices {
  resolve: (spec: string) => {
    spec: string;
    model: () => Promise<ModelClient>;
    info: ModelInfo;
    maxTokens?: number;
  };
  configured?: readonly string[];
}

export interface ModelStateOptions {
  modelId: string;
  model: ModelClient | (() => Promise<ModelClient>);
  limits: RunLimits;
  price?: Price | undefined;
  thinkingCaps?: ThinkingCaps | undefined;
  maxTokens?: number | undefined;
  choices?: ModelChoices | undefined;
  settings: Settings;
  policy?: TeamPolicy | undefined;
}

export class ModelState {
  modelId: string;
  limits: RunLimits;
  price: Price | undefined;
  thinkingCaps: ThinkingCaps | undefined;
  thinkingChoice: ThinkingChoice = {};
  maxTokens: number | undefined;
  choices: ModelChoices | undefined;
  private model: ModelClient | (() => Promise<ModelClient>);
  private readonly settings: Settings;
  private readonly policy: TeamPolicy | undefined;

  constructor(options: ModelStateOptions) {
    this.modelId = options.modelId;
    this.model = options.model;
    this.limits = options.limits;
    this.price = options.price;
    this.thinkingCaps = options.thinkingCaps;
    this.maxTokens = options.maxTokens;
    this.choices = options.choices;
    this.settings = options.settings;
    this.policy = options.policy;
  }

  async client(): Promise<ModelClient> {
    assertModelAllowedByPolicy(this.policy, this.modelId);
    if (typeof this.model === "function") this.model = await this.model();
    return this.model;
  }

  get thinkingParams(): ThinkingRequest | undefined {
    return thinkingRequest(this.thinkingChoice, this.thinkingCaps);
  }

  thinkingStatus(): string {
    return thinkingText(this.thinkingChoice, this.thinkingCaps, this.modelId);
  }

  setThinking(word: string, session?: Session): { ok: boolean; text: string } {
    const change = changeThinking(this.thinkingChoice, word, this.thinkingCaps, this.modelId);
    if (!change.ok) return change;
    const before = JSON.stringify(this.thinkingParams ?? {});
    this.thinkingChoice = change.choice;
    session?.journal?.write({ type: "thinking", choice: change.choice });
    const changed = JSON.stringify(this.thinkingParams ?? {}) !== before;
    return {
      ok: true,
      text: changed
        ? `${change.text} The next turn uses it; the prompt cache starts again.`
        : change.text,
    };
  }

  adoptThinking(session: Session): void {
    if (session.thinking === undefined) return;
    this.thinkingChoice = fitThinking(session.thinking, this.thinkingCaps).choice;
  }

  modelList(): { spec: string; info: ModelInfo }[] {
    const out: { spec: string; info: ModelInfo }[] = knownModels().map((m) => ({
      spec: m.id,
      info: m.info,
    }));
    for (const spec of this.choices?.configured ?? []) {
      if (out.some((m) => m.spec === spec)) continue;
      try {
        out.push({ spec, info: this.choices?.resolve(spec).info ?? lookupModel(spec) });
      } catch {
        // Unknown provider
      }
    }
    if (!out.some((m) => m.spec === this.modelId)) {
      out.unshift({
        spec: this.modelId,
        info: {
          contextWindow: this.limits.contextWindow,
          ...(this.price === undefined ? {} : { price: this.price }),
        },
      });
    }
    return out;
  }

  async setModel(
    ref: string,
    session: Session | undefined,
    startFields: () => Omit<StartRecord, "t" | "type" | "sessionId">,
  ): Promise<{ ok: boolean; text: string }> {
    const choices = this.choices;
    if (choices === undefined) return { ok: false, text: "This Garuda cannot switch models." };
    const spec = /^\d+$/.test(ref)
      ? this.modelList()[Number(ref) - 1]?.spec
      : (aliasModel(ref) ?? ref);
    if (spec === undefined) {
      return { ok: false, text: `There is no model ${ref} in the list. Type /models.` };
    }
    let resolved: ReturnType<typeof choices.resolve>;
    let client: ModelClient;
    try {
      assertModelAllowedByPolicy(this.policy, spec);
      if (spec === this.modelId) return { ok: true, text: `${spec} is already the model.` };
      resolved = choices.resolve(spec);
      assertModelAllowedByPolicy(this.policy, resolved.spec);
      client = await resolved.model();
    } catch (error) {
      return { ok: false, text: `Cannot use ${spec}: ${(error as Error).message}` };
    }
    this.model = client;
    this.modelId = resolved.spec;
    this.price = this.settings.price ?? resolved.info.price;
    this.thinkingCaps = resolved.info.thinking;
    const fitted = fitThinking(this.thinkingChoice, resolved.info.thinking);
    this.thinkingChoice = fitted.choice;
    this.limits = {
      ...this.limits,
      contextWindow: this.settings.contextWindow ?? resolved.info.contextWindow,
    };
    this.maxTokens = resolved.maxTokens;
    if (session !== undefined) session.messages = withoutThinking(session.messages);
    session?.journal?.write({ type: "model", sessionId: session.id, ...startFields() });
    const lines = [
      `The model is now ${resolved.spec} (${modelFacts(this.limits.contextWindow, this.price)}). The next turn uses it; the prompt cache starts again.`,
    ];
    if (
      session !== undefined &&
      session.contextTokens > this.limits.contextWindow * COMPACTION_DEFAULTS.threshold
    ) {
      lines.push(
        "The conversation is too large for this model's context window: Garuda compacts it before the next request.",
      );
    }
    if (fitted.dropped.length > 0) {
      lines.push(
        `${resolved.spec} cannot use ${fitted.dropped.join(" and ")}: it goes back to the default.`,
      );
    }
    if (this.price === undefined) {
      lines.push(
        `Garuda has no price for ${resolved.spec}. Set "price" for it in ~/.garuda/models.json to see cost.`,
      );
    }
    return { ok: true, text: lines.join("\n") };
  }
}
