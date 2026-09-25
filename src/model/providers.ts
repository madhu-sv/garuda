import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isLoopbackHost } from "../net/address.js";
import { lookupModel, type ModelInfo, type Price } from "./pricing.js";
import type { ModelClient } from "./types.js";

/**
 * Model providers (0.3). A model spec is "<provider>/<model>" or a plain Claude model id:
 *   claude-sonnet-5                  Anthropic (the default provider)
 *   ollama/qwen3-coder:30b           a local Ollama server
 *   openrouter/qwen/qwen3-coder      OpenRouter (the model part may hold "/")
 *
 * Providers come from built-in presets and from ~/.garuda/models.json. Only the user's own file
 * can define a provider: a project's settings could otherwise send the code and an API key to a
 * server of the repository's choice. API keys come from environment variables, never from files.
 */

export const MODELS_FILE = join(".garuda", "models.json");

const priceSchema = z.strictObject({
  input: z.number().min(0),
  output: z.number().min(0),
  cacheRead: z.number().min(0),
  cacheWrite: z.number().min(0),
});

const providerSchema = z.strictObject({
  type: z.enum(["anthropic", "openai-compatible"]),
  /** For openai-compatible: the URL that ends before /chat/completions. */
  baseUrl: z.url().optional(),
  /** The environment variable that holds the API key. */
  apiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
  /** A server on this machine: price 0 unless a model entry says otherwise. */
  local: z.boolean().optional(),
  /** Allow plain http to a host that is not this machine. Off: an API key could travel in clear text. */
  allowInsecureHttp: z.boolean().optional(),
});

const modelSchema = z.strictObject({
  contextWindow: z.number().int().min(4_096).optional(),
  price: priceSchema.optional(),
  maxTokens: z.number().int().min(256).optional(),
});

const fileSchema = z.strictObject({
  providers: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), providerSchema).default({}),
  /** Keyed by the full spec, for example "ollama/qwen3-coder:30b". */
  models: z.record(z.string(), modelSchema).default({}),
});

export type ProviderDef = z.infer<typeof providerSchema>;
export type ModelsConfig = z.infer<typeof fileSchema>;

export const BUILTIN_PROVIDERS: Readonly<Record<string, ProviderDef>> = {
  anthropic: { type: "anthropic" },
  ollama: { type: "openai-compatible", baseUrl: "http://localhost:11434/v1", local: true },
  lmstudio: { type: "openai-compatible", baseUrl: "http://localhost:1234/v1", local: true },
  llamacpp: { type: "openai-compatible", baseUrl: "http://localhost:8080/v1", local: true },
  vllm: { type: "openai-compatible", baseUrl: "http://localhost:8000/v1", local: true },
  openrouter: {
    type: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
};

/**
 * Context window for an open model that the config does not describe. Small on purpose:
 * compaction then starts early, and a local server with a small window does not cut the
 * conversation silently. Set the real value in ~/.garuda/models.json.
 */
export const OPEN_MODEL_DEFAULT_WINDOW = 32_768;
const ZERO_PRICE: Price = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface ResolvedModel {
  /** The spec as the user wrote it; sessions record it. */
  spec: string;
  provider: string;
  /** The model name that the provider gets. */
  model: string;
  def: ProviderDef;
  info: ModelInfo;
  maxTokens?: number;
  /** Things the user should know, for example an assumed context window. */
  notes: string[];
  /** Load the adapter and build the client (on first use, N3). */
  create(env?: NodeJS.ProcessEnv): Promise<ModelClient>;
}

export async function loadModelsConfig(
  home: string = homedir(),
): Promise<{ config: ModelsConfig; problem?: string }> {
  const file = join(home, MODELS_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { config: { providers: {}, models: {} } };
    return {
      config: { providers: {}, models: {} },
      problem: `${file}: ${(error as Error).message}`,
    };
  }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      return {
        config: { providers: {}, models: {} },
        problem: `${file}: ${z.prettifyError(parsed.error)}`,
      };
    }
    return { config: parsed.data };
  } catch (error) {
    return {
      config: { providers: {}, models: {} },
      problem: `${file}: invalid JSON: ${(error as Error).message}`,
    };
  }
}

export function resolveModel(
  spec: string,
  config: ModelsConfig = { providers: {}, models: {} },
): ResolvedModel {
  const providers = { ...BUILTIN_PROVIDERS, ...config.providers };
  const slash = spec.indexOf("/");
  const [provider, model] =
    slash === -1 ? ["anthropic", spec] : [spec.slice(0, slash), spec.slice(slash + 1)];
  const def = providers[provider];
  if (def === undefined) {
    throw new Error(
      `Unknown model provider "${provider}" in "${spec}". Known providers: ${Object.keys(providers).join(", ")}. Add others in ~/${MODELS_FILE}.`,
    );
  }
  if (model === "") throw new Error(`"${spec}" names no model. Use <provider>/<model>.`);
  if (def.type === "openai-compatible") checkBaseUrl(provider, def);

  const entry =
    config.models[spec] ?? (provider === "anthropic" ? config.models[model] : undefined);
  const base: ModelInfo =
    def.type === "anthropic"
      ? lookupModel(model)
      : { contextWindow: OPEN_MODEL_DEFAULT_WINDOW, ...(def.local ? { price: ZERO_PRICE } : {}) };
  const info: ModelInfo = {
    contextWindow: entry?.contextWindow ?? base.contextWindow,
    ...(entry?.price !== undefined
      ? { price: entry.price }
      : base.price !== undefined
        ? { price: base.price }
        : {}),
  };

  const notes: string[] = [];
  if (def.type === "openai-compatible" && entry?.contextWindow === undefined) {
    notes.push(
      `Garuda assumes a ${OPEN_MODEL_DEFAULT_WINDOW}-token context window for ${spec}. Set the real value ("contextWindow") for "${spec}" in ~/${MODELS_FILE}; the server must allow it too (for Ollama: OLLAMA_CONTEXT_LENGTH).`,
    );
  }
  return {
    spec,
    provider,
    model,
    def,
    info,
    notes,
    ...(entry?.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
    async create(env = process.env) {
      const apiKey = def.apiKeyEnv === undefined ? undefined : env[def.apiKeyEnv];
      if (def.apiKeyEnv !== undefined && (apiKey === undefined || apiKey === "")) {
        throw new Error(`Set ${def.apiKeyEnv} to use the ${provider} provider.`);
      }
      if (def.type === "anthropic") {
        const { AnthropicClient } = await import("./anthropic.js");
        return new AnthropicClient({ model, ...(apiKey === undefined ? {} : { apiKey }) });
      }
      const { OpenAICompatibleClient } = await import("./openaiCompatible.js");
      return new OpenAICompatibleClient({
        provider,
        baseUrl: def.baseUrl as string,
        model,
        ...(apiKey === undefined ? {} : { apiKey }),
      });
    },
  };
}

/**
 * The base URL must be http(s). Plain http only to this machine, unless the provider allows it:
 * an API key and the whole conversation would otherwise cross the network in clear text.
 */
function checkBaseUrl(provider: string, def: ProviderDef): void {
  if (def.baseUrl === undefined) throw new Error(`Provider "${provider}" needs a baseUrl.`);
  const url = new URL(def.baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Provider "${provider}": the baseUrl must use http or https.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`Provider "${provider}": put credentials in apiKeyEnv, not in the baseUrl.`);
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname) && def.allowInsecureHttp !== true) {
    throw new Error(
      `Provider "${provider}" uses plain http to ${url.hostname}. Use https, or set "allowInsecureHttp": true for a trusted network.`,
    );
  }
}
