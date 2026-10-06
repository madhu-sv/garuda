import { homedir } from "node:os";
import {
  credentialsPath,
  KEY_NAME,
  maskKey,
  readCredentials,
  writeCredentials,
} from "../model/credentials.js";
import { knownModels } from "../model/pricing.js";
import {
  BUILTIN_PROVIDERS,
  chooseModel,
  loadModelsConfig,
  MODELS_FILE,
  type ModelsConfig,
  type ProviderDef,
  resolveModel,
  setDefaultModel,
} from "../model/providers.js";

/**
 * `garuda setup` (0.16, docs/lld/setup.md): choose a provider and a model, enter the provider's key
 * once, check it with a free request, and store the model in ~/.garuda/models.json and the key in
 * ~/.garuda/credentials. Editors run it as ACP Terminal Auth. Exit code 0 means done.
 */

export interface Choice<T> {
  name: string;
  value: T;
  description?: string;
}

/** The questions and the output. The terminal gives inquirer; tests give scripted answers. */
export interface SetupIO {
  /** Both stdin and stdout are a terminal. */
  interactive: boolean;
  select<T>(message: string, choices: Choice<T>[]): Promise<T>;
  input(message: string, initial?: string): Promise<string>;
  /** Hidden input. */
  secret(message: string): Promise<string>;
  confirm(message: string, initial: boolean): Promise<boolean>;
  print(text: string): void;
}

export interface SetupOptions {
  show?: boolean;
  /** `--forget` alone: all keys; `--forget <name>`: one key. */
  forget?: string | boolean;
}

export interface SetupDeps {
  io: SetupIO;
  home?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
}

/** The longest wait for the key check and for a local server's model list. */
export const CHECK_TIMEOUT_MS = 10_000;

const LOCAL_LIST_TIMEOUT_MS = 2_000;
/** Not a model name: it has a space, and listed names must be ONE_WORD. */
const OTHER = "another model";
/** Visible ASCII, no spaces: model names and keys (no control or hidden characters). */
const ONE_WORD = /^[!-~]+$/;

const PROVIDER_TITLES: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  openrouter: "OpenRouter",
  ollama: "Ollama (this machine)",
  lmstudio: "LM Studio (this machine)",
  llamacpp: "llama.cpp (this machine)",
  vllm: "vLLM (this machine)",
};

export async function setupCommand(options: SetupOptions, deps: SetupDeps): Promise<number> {
  const { io } = deps;
  if ((deps.platform ?? process.platform) === "win32") {
    // A key file needs Unix permissions (0600) to stay private; Windows has other rules.
    io.print(
      "Garuda supports macOS and Linux. On Windows, run Garuda in WSL (Windows Subsystem for Linux).",
    );
    return 1;
  }
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  const models = await loadModelsConfig(home);
  if (models.problem !== undefined) {
    io.print(models.problem);
    return 1;
  }
  if (options.show === true) return show(io, models.config, home, env);
  if (!io.interactive) {
    io.print(
      "garuda setup asks questions, so it needs a terminal. In a script, set the key in its environment variable (for example ANTHROPIC_API_KEY) and the model with --model or GARUDA_MODEL.",
    );
    return 1;
  }
  try {
    if (options.forget !== undefined && options.forget !== false) {
      return await forget(io, home, options.forget === true ? undefined : options.forget);
    }
    return await setup(io, models.config, home, env, deps.fetch ?? fetch);
  } catch (error) {
    // Inquirer reads keys in raw mode: Ctrl-C arrives as this error, not as SIGINT.
    if ((error as Error).name === "ExitPromptError") {
      io.print("Setup stopped. Nothing changed.");
      return 130;
    }
    throw error;
  }
}

async function setup(
  io: SetupIO,
  config: ModelsConfig,
  home: string,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
): Promise<number> {
  const stored = await readCredentials(home);
  if (stored.warning !== undefined) {
    // Never write over a file that Garuda would not read (a link, another owner, loose bits).
    io.print(stored.warning);
    io.print(`Fix or remove ${credentialsPath(home)}, then run garuda setup again.`);
    return 1;
  }
  const providers = { ...BUILTIN_PROVIDERS, ...config.providers };

  // 1. The provider.
  const provider = await io.select(
    "Provider",
    Object.keys(providers).map((name) => ({
      name: PROVIDER_TITLES[name] ?? `${name} (~/${MODELS_FILE})`,
      value: name,
      ...(config.providers[name] === undefined ? {} : { description: "from your models.json" }),
    })),
  );
  const def = providers[provider] as ProviderDef;

  // 2. The model.
  const model = await pickModel(io, provider, def, fetcher);
  const spec = provider === "anthropic" ? model : `${provider}/${model}`;
  try {
    resolveModel(spec, config);
  } catch (error) {
    io.print((error as Error).message);
    return 1;
  }

  // 3. The key, and 4. the check.
  const keyName = def.type === "anthropic" ? (def.apiKeyEnv ?? "ANTHROPIC_API_KEY") : def.apiKeyEnv;
  let newKey: string | undefined;
  if (keyName !== undefined) {
    const fromEnv = env[keyName] ?? "";
    const old = stored.keys[keyName];
    if (fromEnv !== "") {
      io.print(
        `${keyName} is set in your environment, and it wins over a stored key. Garuda stores no key for it.`,
      );
    } else if (
      old !== undefined &&
      (await io.confirm(`Keep the stored ${keyName} (${maskKey(old)})?`, true))
    ) {
      // Kept as it is.
    } else {
      newKey = await askKey(io, keyName);
    }
    if (await io.confirm("Check the key now? (a free request that lists models)", true)) {
      for (;;) {
        const key = fromEnv !== "" ? fromEnv : (newKey ?? old);
        const result = await checkKey(provider, def, key, env, fetcher);
        io.print(result.message);
        if (result.ok) break;
        const next = await io.select("What now?", [
          ...(fromEnv === "" ? [{ name: "Enter the key again", value: "again" as const }] : []),
          { name: "Store it anyway", value: "store" as const },
          { name: "Stop (nothing changes)", value: "stop" as const },
        ]);
        if (next === "stop") {
          io.print("Setup stopped. Nothing changed.");
          return 1;
        }
        if (next === "store") break;
        newKey = await askKey(io, keyName);
      }
    }
  } else if (def.local === true) {
    const result = await checkKey(provider, def, undefined, env, fetcher);
    io.print(result.ok ? result.message : `${result.message} Start the server before you use it.`);
  }

  // 5. Store.
  await setDefaultModel(spec, home);
  if (newKey !== undefined && keyName !== undefined) {
    await writeCredentials({ ...stored.keys, [keyName]: newKey }, home);
  }
  io.print("");
  io.print(`Model: ${spec} (the default in ~/${MODELS_FILE})`);
  if (keyName !== undefined) {
    const where =
      (env[keyName] ?? "") !== "" ? "from your environment" : `in ${credentialsPath(home)}`;
    const key =
      (env[keyName] ?? "") !== ""
        ? (env[keyName] as string)
        : (newKey ?? stored.keys[keyName] ?? "");
    io.print(`Key: ${keyName} ${maskKey(key)} ${where}`);
  }
  if ((env.GARUDA_MODEL ?? "") !== "") {
    io.print(`GARUDA_MODEL is set (${env.GARUDA_MODEL}), and it wins over this default.`);
  }
  io.print("Done. Start Garuda with: garuda");
  return 0;
}

async function pickModel(
  io: SetupIO,
  provider: string,
  def: ProviderDef,
  fetcher: typeof fetch,
): Promise<string> {
  let listed: string[] = [];
  const notes = new Map<string, string>();
  if (def.type === "anthropic") {
    for (const { id, info } of knownModels()) {
      listed.push(id);
      if (info.price !== undefined) {
        notes.set(id, `$${info.price.input} in, $${info.price.output} out per million tokens`);
      }
    }
  } else if (def.local === true && def.baseUrl !== undefined) {
    listed = await localModels(def.baseUrl, fetcher);
  }
  if (listed.length > 0) {
    const picked = await io.select("Model", [
      ...listed.map((id) => {
        const note = notes.get(id);
        return { name: id, value: id, ...(note === undefined ? {} : { description: note }) };
      }),
      { name: "Another model (type its name)", value: OTHER },
    ]);
    if (picked !== OTHER) return picked;
  }
  for (;;) {
    const typed = (
      await io.input(
        provider === "openrouter" ? "Model (for example qwen/qwen3-coder)" : "Model name",
      )
    ).trim();
    if (typed !== "" && ONE_WORD.test(typed)) return typed;
    io.print("Type a model name with no spaces.");
  }
}

/** The models that a local server lists, or none when it does not answer quickly. */
async function localModels(baseUrl: string, fetcher: typeof fetch): Promise<string[]> {
  try {
    const response = await fetcher(`${baseUrl.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(LOCAL_LIST_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length <= 200 && ONE_WORD.test(id))
      .slice(0, 50);
  } catch {
    return [];
  }
}

async function askKey(io: SetupIO, keyName: string): Promise<string> {
  for (;;) {
    const key = (await io.secret(`${keyName} (the input is hidden)`)).trim();
    if (key !== "" && key.length <= 4_096 && ONE_WORD.test(key)) return key;
    io.print("A key is one word with no spaces. Paste it again.");
  }
}

interface CheckResult {
  ok: boolean;
  message: string;
}

/**
 * One free request with the key, to the provider's own base URL (never another host): Anthropic
 * `GET /v1/models`, OpenAI-compatible `GET <baseUrl>/models`. No model call, no cost.
 */
export async function checkKey(
  provider: string,
  def: ProviderDef,
  key: string | undefined,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
): Promise<CheckResult> {
  let url: string;
  const headers: Record<string, string> = {};
  if (def.type === "anthropic") {
    // The SDK's own base URL: where the model calls will go too.
    const base =
      (env.ANTHROPIC_BASE_URL ?? "") !== "" ? env.ANTHROPIC_BASE_URL : "https://api.anthropic.com";
    url = `${(base as string).replace(/\/+$/, "")}/v1/models?limit=1`;
    headers["anthropic-version"] = "2023-06-01";
    if (key !== undefined) headers["x-api-key"] = key;
  } else {
    url = `${(def.baseUrl as string).replace(/\/+$/, "")}/models`;
    if (key !== undefined) headers.authorization = `Bearer ${key}`;
  }
  const host = new URL(url).host;
  try {
    const response = await fetcher(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.ok) {
      return {
        ok: true,
        message:
          key === undefined
            ? `${provider} answered at ${host}.`
            : `${provider} answered: the key works.`,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `${provider} refused the key (HTTP ${response.status}).` };
    }
    return { ok: false, message: `${host} answered HTTP ${response.status}.` };
  } catch (error) {
    const reason =
      (error as Error).name === "TimeoutError"
        ? "no answer in time"
        : ((error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message);
    return { ok: false, message: `Garuda could not reach ${host} (${reason}).` };
  }
}

/** `--show`: the model and, per key name, where the key comes from. Never a whole key. */
async function show(
  io: SetupIO,
  config: ModelsConfig,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const stored = await readCredentials(home);
  const spec = chooseModel(config, env.GARUDA_MODEL);
  io.print(
    spec === undefined
      ? "Model: none. Run garuda setup."
      : `Model: ${spec} (${(env.GARUDA_MODEL ?? "") !== "" ? "GARUDA_MODEL" : `the default in ~/${MODELS_FILE}`})`,
  );
  const providers = { ...BUILTIN_PROVIDERS, ...config.providers };
  const names = new Set<string>(["ANTHROPIC_API_KEY"]);
  for (const def of Object.values(providers))
    if (def.apiKeyEnv !== undefined) names.add(def.apiKeyEnv);
  for (const name of Object.keys(stored.keys)) names.add(name);
  for (const name of [...names].sort()) {
    const fromEnv = env[name] ?? "";
    const fromFile = stored.keys[name];
    io.print(
      fromEnv !== ""
        ? `${name}: ${maskKey(fromEnv)} from the environment${fromFile === undefined ? "" : " (it wins over the stored key)"}`
        : fromFile !== undefined
          ? `${name}: ${maskKey(fromFile)} in ${credentialsPath(home)}`
          : `${name}: not set`,
    );
  }
  if (stored.warning !== undefined) io.print(stored.warning);
  return 0;
}

/** `--forget [name]`: remove one stored key or all of them, after a question. */
async function forget(io: SetupIO, home: string, name: string | undefined): Promise<number> {
  const stored = await readCredentials(home);
  if (stored.warning !== undefined) {
    io.print(stored.warning);
    return 1;
  }
  const names = Object.keys(stored.keys);
  if (name !== undefined && !KEY_NAME.test(name)) {
    io.print(`"${name}" is not a key name (for example ANTHROPIC_API_KEY).`);
    return 1;
  }
  if (name !== undefined && stored.keys[name] === undefined) {
    io.print(`No stored key is named ${name}.`);
    return 1;
  }
  if (names.length === 0) {
    io.print("No keys are stored.");
    return 0;
  }
  const gone = name === undefined ? names : [name];
  const question =
    gone.length === 1
      ? `Remove the stored ${gone[0]} (${maskKey(stored.keys[gone[0] as string] as string)})?`
      : `Remove all ${gone.length} stored keys (${gone.join(", ")})?`;
  if (!(await io.confirm(question, false))) {
    io.print("Nothing changed.");
    return 0;
  }
  const rest = Object.fromEntries(Object.entries(stored.keys).filter(([n]) => !gone.includes(n)));
  await writeCredentials(rest, home);
  io.print(`Removed: ${gone.join(", ")}.`);
  return 0;
}

/** The terminal: inquirer, loaded on first use (N3). */
export async function terminalIO(): Promise<SetupIO> {
  const { confirm, input, password, select } = await import("@inquirer/prompts");
  return {
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    select: (message, choices) => select({ message, choices, pageSize: 12 }),
    input: (message, initial) =>
      input({ message, ...(initial === undefined ? {} : { default: initial }) }),
    secret: (message) => password({ message, mask: "*" }),
    confirm: (message, initial) => confirm({ message, default: initial }),
    print: (text) => process.stdout.write(`${text}\n`),
  };
}
