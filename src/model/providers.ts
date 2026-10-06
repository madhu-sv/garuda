import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isLoopbackHost } from "../net/address.js";
import { keepSecretForRedaction } from "../session/redact.js";
import { writeFileAtomic } from "../tools/atomicWrite.js";
import { readCredentials } from "./credentials.js";
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
 * server of the repository's choice. API keys come from environment variables or (0.16) from
 * ~/.garuda/credentials, which only `garuda setup` writes; never from a project file.
 */

export const MODELS_FILE = join(".garuda", "models.json");

/** No --model, no GARUDA_MODEL and no default model in ~/.garuda/models.json. */
export const NO_MODEL =
  "Set a model with --model <id> or the GARUDA_MODEL variable, or run `garuda setup`.";

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
  /**
   * Tool calls that the model writes as JSON text (openai-compatible only): "whole" (default) when
   * the whole reply is calls, "lines" when calls stand on their own lines between prose, "off".
   */
  textToolCalls: z.enum(["off", "whole", "lines"]).optional(),
});

const fileSchema = z.strictObject({
  providers: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), providerSchema).default({}),
  /** Keyed by the full spec, for example "ollama/qwen3-coder:30b". */
  models: z.record(z.string(), modelSchema).default({}),
  /** The model when neither --model nor GARUDA_MODEL names one (0.16; `garuda setup` writes it). */
  default: z.string().min(1).optional(),
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
  /** The Batch API client (0.7): only for the Anthropic provider. Half price, minutes per step. */
  createBatch?(
    env?: NodeJS.ProcessEnv,
    options?: Pick<import("./anthropic.js").AnthropicBatchClientOptions, "onWait">,
  ): Promise<ModelClient>;
}

/**
 * The model spec to use: the first one given (--model, a job's model, GARUDA_MODEL, in that
 * order), else the default model in ~/.garuda/models.json (0.16). An empty string counts as unset.
 */
export function chooseModel(
  config: Pick<ModelsConfig, "default">,
  ...given: ReadonlyArray<string | undefined>
): string | undefined {
  for (const spec of given) if (spec !== undefined && spec !== "") return spec;
  return config.default;
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

/**
 * Set the default model in ~/.garuda/models.json (0.16, `garuda setup`). The rest of the file stays
 * as it is (its JSON is written again with two-space indents). A file that is not a JSON object is
 * an error, never replaced.
 */
export async function setDefaultModel(spec: string, home: string = homedir()): Promise<void> {
  const file = join(home, MODELS_FILE);
  let data: Record<string, unknown> = {};
  let exists = true;
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${file} is not a JSON object.`);
    }
    data = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  data.default = spec;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { createOnly: !exists });
}

/**
 * Provider API keys that Garuda has taken out of its own process environment (0.14, review): a
 * command in the OS sandbox could read /proc/<pid>/environ of the Garuda process and get the key
 * from it, past the command's own environment allowlist. `keepProviderKey` moves the value here, so
 * it is no longer in `process.env`; `create` reads it from here. The sandbox strips secret-named
 * variables from a command anyway, so nothing a command should see is lost.
 */
const keptKeys = new Map<string, { value: string; from: KeySource }>();

/** Where a provider key came from: an environment variable, or ~/.garuda/credentials (0.16). */
export type KeySource = "environment" | "file";

/** Take a key variable out of process.env and keep it for `create`. Safe to call more than once. */
export function keepProviderKey(name: string): void {
  const value = process.env[name];
  if (value !== undefined && value !== "") {
    keptKeys.set(name, { value, from: "environment" });
    keepSecretForRedaction(name, value);
    delete process.env[name];
  }
}

/**
 * A key from ~/.garuda/credentials (0.16). An environment variable wins: the key is used only when
 * no variable of that name is set or kept. A later read of the file replaces an older stored key.
 */
export function keepStoredKey(name: string, value: string): boolean {
  if ((process.env[name] ?? "") !== "") return false;
  if (keptKeys.get(name)?.from === "environment") return false;
  keptKeys.set(name, { value, from: "file" });
  keepSecretForRedaction(name, value);
  return true;
}

/** True when this key variable is set, in process.env or already kept (for the init line). */
export function hasProviderKey(name: string): boolean {
  return keptKeys.has(name) || (process.env[name] ?? "") !== "";
}

/** Where the key of this name comes from, or undefined when there is none. */
export function providerKeySource(name: string): KeySource | undefined {
  if ((process.env[name] ?? "") !== "") return "environment";
  return keptKeys.get(name)?.from;
}

/**
 * At startup: the keys of these names leave process.env (0.14, review), and stored keys from
 * ~/.garuda/credentials fill every name that no variable sets (0.16). The redactor knows every
 * stored key, also one that a variable overrides. Returns a warning when the file was ignored.
 */
export async function keepProviderKeys(
  names: ReadonlyArray<string | undefined>,
  home?: string,
): Promise<string | undefined> {
  const wanted = names.filter((name): name is string => name !== undefined);
  for (const name of wanted) keepProviderKey(name);
  const stored = await readCredentials(home);
  for (const [name, value] of Object.entries(stored.keys)) {
    // All stored keys, so `/model` can switch to another stored provider. The redactor knows each.
    if (!keepStoredKey(name, value)) keepSecretForRedaction(name, value);
  }
  return stored.warning;
}

function providerKey(env: NodeJS.ProcessEnv, name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  return keptKeys.get(name)?.value ?? env[name];
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
    // Thinking by model (0.9): only Claude models on the Anthropic provider have it.
    ...(base.thinking === undefined ? {} : { thinking: base.thinking }),
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
    ...(def.type === "anthropic"
      ? {
          async createBatch(
            env: NodeJS.ProcessEnv = process.env,
            options: Pick<import("./anthropic.js").AnthropicBatchClientOptions, "onWait"> = {},
          ) {
            // The Anthropic key defaults to ANTHROPIC_API_KEY (the SDK's own variable); passing it
            // explicitly lets the CLI take it out of process.env (0.14, review).
            const apiKey = providerKey(env, def.apiKeyEnv ?? "ANTHROPIC_API_KEY");
            const { AnthropicBatchClient } = await import("./anthropic.js");
            return new AnthropicBatchClient({ model, ...(apiKey ? { apiKey } : {}), ...options });
          },
        }
      : {}),
    async create(env = process.env) {
      const apiKey = providerKey(env, def.apiKeyEnv);
      if (def.apiKeyEnv !== undefined && (apiKey === undefined || apiKey === "")) {
        throw new Error(
          `Set ${def.apiKeyEnv} to use the ${provider} provider, or run \`garuda setup\`.`,
        );
      }
      if (def.type === "anthropic") {
        // Default to ANTHROPIC_API_KEY so the key is passed explicitly and can be taken out of
        // process.env (0.14, review). With no key at all, the SDK still tries its other methods.
        const key = providerKey(env, def.apiKeyEnv ?? "ANTHROPIC_API_KEY");
        const { AnthropicClient } = await import("./anthropic.js");
        return new AnthropicClient({ model, ...(key ? { apiKey: key } : {}) });
      }
      const { OpenAICompatibleClient } = await import("./openaiCompatible.js");
      return new OpenAICompatibleClient({
        provider,
        baseUrl: def.baseUrl as string,
        model,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(entry?.textToolCalls === undefined ? {} : { textToolCalls: entry.textToolCalls }),
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
