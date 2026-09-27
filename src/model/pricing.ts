import type { Usage } from "./types.js";

/** USD per million tokens. `cacheWrite` is the 5-minute cache write price. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelInfo {
  /** Undefined when Garuda does not know the model: cost then shows as unknown. */
  price?: Price;
  contextWindow: number;
}

export const DEFAULT_CONTEXT_WINDOW = 200_000;

const M = 1_000_000;

/**
 * Known Claude models, by model-id prefix. The longest matching prefix wins,
 * so "claude-opus-5-5" does not fall back to "claude-opus-5".
 * Source: platform.claude.com/docs/en/about-claude/pricing (September 2026).
 * Settings can override both values (`model.price`, `model.contextWindow`).
 */
const KNOWN: ReadonlyArray<readonly [prefix: string, info: ModelInfo]> = [
  ["claude-fable-5-1", { price: p(10, 50, 0.25, 12.5), contextWindow: M }],
  ["claude-fable-5", { price: p(10, 50, 1, 12.5), contextWindow: M }],
  ["claude-opus-5-5", { price: p(4, 20, 0.2, 5), contextWindow: M }],
  ["claude-opus-5", { price: p(5, 25, 0.5, 6.25), contextWindow: M }],
  ["claude-opus-4-8", { price: p(5, 25, 0.5, 6.25), contextWindow: M }],
  ["claude-opus-4-7", { price: p(5, 25, 0.5, 6.25), contextWindow: M }],
  ["claude-opus-4-6", { price: p(5, 25, 0.5, 6.25), contextWindow: M }],
  ["claude-opus-4-5", { price: p(5, 25, 0.5, 6.25), contextWindow: 200_000 }],
  ["claude-sonnet-5", { price: p(2, 10, 0.2, 2.5), contextWindow: M }],
  ["claude-sonnet-4-6", { price: p(3, 15, 0.3, 3.75), contextWindow: M }],
  ["claude-sonnet-4-5", { price: p(3, 15, 0.3, 3.75), contextWindow: 200_000 }],
  ["claude-haiku-4-5", { price: p(1, 5, 0.1, 1.25), contextWindow: 200_000 }],
];

function p(input: number, output: number, cacheRead: number, cacheWrite: number): Price {
  return { input, output, cacheRead, cacheWrite };
}

/**
 * The newest known model id of a family: haiku, sonnet, opus or fable (0.5, for `model: sonnet` in
 * an agent file, as in Claude Code). Undefined for other names.
 */
export function aliasModel(alias: string): string | undefined {
  if (!/^(haiku|sonnet|opus|fable)$/.test(alias)) return undefined;
  return KNOWN.find(([prefix]) => prefix.startsWith(`claude-${alias}-`))?.[0];
}

/** The Claude models that Garuda knows, newest first (for /models, 0.6). */
export function knownModels(): { id: string; info: ModelInfo }[] {
  return KNOWN.map(([id, info]) => ({ id, info }));
}

export function lookupModel(modelId: string): ModelInfo {
  let best: { prefix: string; info: ModelInfo } | undefined;
  for (const [prefix, info] of KNOWN) {
    if (modelId.startsWith(prefix) && prefix.length > (best?.prefix.length ?? 0)) {
      best = { prefix, info };
    }
  }
  return best?.info ?? { contextWindow: DEFAULT_CONTEXT_WINDOW };
}

/** Claude's web search (0.6): USD per search ($10 per 1,000), on top of the tokens. */
export const WEB_SEARCH_USD = 0.01;

/** The Batch API price (0.7): half of every token price, cache reads and writes too. */
export function batchPrice(price: Price): Price {
  return {
    input: price.input / 2,
    output: price.output / 2,
    cacheRead: price.cacheRead / 2,
    cacheWrite: price.cacheWrite / 2,
  };
}

/** Cost of one response in USD, server web searches included. */
export function costOf(usage: Usage, price: Price): number {
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
      M +
    (usage.webSearches ?? 0) * WEB_SEARCH_USD
  );
}

/** All tokens that one response processed. The token budget (F6) counts these. */
export function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** The size of the context after a response: the next request is at least this large. */
export function contextSize(usage: Usage): number {
  return totalTokens(usage);
}
