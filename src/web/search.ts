import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isLoopbackHost } from "../net/address.js";

/**
 * Web search backends (0.5): Brave Search, Tavily and SearXNG. The user picks one in
 * ~/.garuda/search.json, or Garuda finds a key in the environment (BRAVE_API_KEY, then
 * TAVILY_API_KEY). Only the user's own file and environment configure search: a project cannot
 * send queries somewhere else. Keys come only from environment variables, never from files.
 *
 *   { "provider": "brave" }                                   key in BRAVE_API_KEY
 *   { "provider": "tavily", "apiKeyEnv": "MY_TAVILY_KEY" }    another variable
 *   { "provider": "searxng", "url": "http://localhost:8888" } your own SearXNG (JSON format on)
 *
 * Claude's own web search (0.6) runs on Anthropic's servers, inside the model reply, only with a
 * Claude model. A "claude" section turns it on; the chat asks once per session before it is used.
 * The provider above (or a key in the environment) is the fallback: for other models, or when the
 * user says no.
 *
 *   { "claude": { "maxUses": 5 } }                            Claude's search; Tavily from the env
 *   { "provider": "brave", "claude": { "blockedDomains": ["example.com"] } }
 *
 * `use` (0.14) is the user's choice, so Garuda does not ask: "claude" (Claude's search, the provider
 * as the fallback for other models), "provider" (only the provider) or "off" (no web search).
 * Without it the chat asks once and saves the answer here; `garuda init` and `/search` set it too.
 *
 *   { "use": "claude", "claude": {}, "provider": "tavily" }
 */

export const SEARCH_FILE = join(".garuda", "search.json");
export const SEARCH_TIMEOUT_MS = 20_000;
export const SEARCH_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_RESULTS = 5;
export const MAX_RESULTS = 10;

export type SearchProvider = "brave" | "tavily" | "searxng";

/** Which web search the user chose (0.14): saved in search.json as `use`. */
export const SEARCH_USES = ["claude", "provider", "off"] as const;
export type SearchUse = (typeof SEARCH_USES)[number];

/** Searches per model request for Claude's search, by default. */
export const DEFAULT_CLAUDE_MAX_USES = 5;

const domains = z.array(
  z
    .string()
    .min(1)
    .regex(/^[^\s:/][^\s:]*$/, "a bare domain, with an optional path (no scheme)"),
);

const claudeSchema = z
  .strictObject({
    /** Searches per model request, 1–20. Default 5. */
    maxUses: z.number().int().min(1).max(20).optional(),
    allowedDomains: domains.optional(),
    blockedDomains: domains.optional(),
  })
  .refine((c) => c.allowedDomains === undefined || c.blockedDomains === undefined, {
    message: "use allowedDomains or blockedDomains, not both",
  });

const fileSchema = z.strictObject({
  /** The user's choice (0.14); absent: the chat asks once and saves the answer. */
  use: z.enum(SEARCH_USES).optional(),
  provider: z.enum(["brave", "tavily", "searxng"]).optional(),
  /** Claude's own web search (0.6). */
  claude: claudeSchema.optional(),
  /** SearXNG only: the server's base URL. */
  url: z.string().optional(),
  /** The environment variable with the key. Default: BRAVE_API_KEY or TAVILY_API_KEY. */
  apiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
  /** Results per search, 1–10. Default 5. */
  maxResults: z.number().int().min(1).max(MAX_RESULTS).optional(),
});

export interface SearchConfig {
  provider: SearchProvider;
  /** The endpoint Garuda calls. */
  endpoint: URL;
  /** The key, from the environment (Brave, Tavily). */
  apiKey?: string;
  maxResults: number;
}

/** Claude's own web search (0.6): a server tool of the Anthropic API. */
export interface ClaudeSearchConfig {
  maxUses: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** "3 days ago", "2026-09-01" … when the backend gives it. */
  age?: string;
}

const LABELS: Record<SearchProvider, string> = {
  brave: "Brave Search",
  tavily: "Tavily",
  searxng: "SearXNG",
};

export function providerLabel(config: SearchConfig): string {
  return `${LABELS[config.provider]} (${config.endpoint.host})`;
}

/**
 * The search config: ~/.garuda/search.json, else a key in the environment, else undefined (no
 * web_search tool). `problem` explains a file or key that cannot be used.
 */
export async function loadSearchConfig(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  config?: SearchConfig;
  claude?: ClaudeSearchConfig;
  use?: SearchUse;
  problem?: string;
}> {
  const file = join(home, SEARCH_FILE);
  let text: string | undefined;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { problem: `${file}: ${(error as Error).message}` };
    }
  }
  if (text === undefined) return fromEnv(env, DEFAULT_RESULTS);
  let parsed: z.infer<typeof fileSchema>;
  try {
    const result = fileSchema.safeParse(JSON.parse(text));
    if (!result.success) return { problem: `${file}: ${z.prettifyError(result.error)}` };
    parsed = result.data;
  } catch (error) {
    return { problem: `${file}: invalid JSON: ${(error as Error).message}` };
  }
  const max = parsed.maxResults ?? DEFAULT_RESULTS;
  const use: { use?: SearchUse } = parsed.use === undefined ? {} : { use: parsed.use };
  const claude: { claude?: ClaudeSearchConfig } =
    parsed.claude === undefined
      ? {}
      : {
          claude: {
            maxUses: parsed.claude.maxUses ?? DEFAULT_CLAUDE_MAX_USES,
            ...(parsed.claude.allowedDomains === undefined
              ? {}
              : { allowedDomains: parsed.claude.allowedDomains }),
            ...(parsed.claude.blockedDomains === undefined
              ? {}
              : { blockedDomains: parsed.claude.blockedDomains }),
          },
        };
  if (parsed.provider === undefined) {
    if (parsed.claude === undefined && parsed.use === undefined) {
      return { problem: `${file}: name a "provider", or add a "claude" section.` };
    }
    // The fallback comes from a key in the environment, if there is one.
    return { ...fromEnv(env, max), ...claude, ...use };
  }
  const client = clientConfig(file, { ...parsed, provider: parsed.provider }, env, max);
  return "problem" in client
    ? { ...client, ...claude, ...use }
    : { config: client.config, ...claude, ...use };
}

/**
 * Save the user's search choice as `use` in ~/.garuda/search.json (0.14). The other keys stay as
 * they are; a missing file is created. Only the user's own commands call this (the first-time
 * question, `garuda init`, `/search default`).
 */
export async function saveSearchUse(home: string, use: SearchUse): Promise<string> {
  const file = join(home, SEARCH_FILE);
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...data, use }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function fromEnv(env: NodeJS.ProcessEnv, max: number): { config?: SearchConfig } {
  if (env.BRAVE_API_KEY) return { config: brave(env.BRAVE_API_KEY, max) };
  if (env.TAVILY_API_KEY) return { config: tavily(env.TAVILY_API_KEY, max) };
  return {};
}

function clientConfig(
  file: string,
  parsed: z.infer<typeof fileSchema> & { provider: SearchProvider },
  env: NodeJS.ProcessEnv,
  max: number,
): { config: SearchConfig } | { problem: string } {
  if (parsed.provider === "searxng") {
    if (parsed.url === undefined) return { problem: `${file}: "searxng" needs a "url".` };
    const endpoint = searxngEndpoint(parsed.url);
    if (typeof endpoint === "string") return { problem: `${file}: ${endpoint}` };
    return { config: { provider: "searxng", endpoint, maxResults: max } };
  }
  const variable =
    parsed.apiKeyEnv ?? (parsed.provider === "brave" ? "BRAVE_API_KEY" : "TAVILY_API_KEY");
  const key = env[variable];
  if (!key) return { problem: `${file}: web search needs the key in ${variable}; it is not set.` };
  return { config: parsed.provider === "brave" ? brave(key, max) : tavily(key, max) };
}

function brave(apiKey: string, maxResults: number): SearchConfig {
  return {
    provider: "brave",
    endpoint: new URL("https://api.search.brave.com/res/v1/web/search"),
    apiKey,
    maxResults,
  };
}

function tavily(apiKey: string, maxResults: number): SearchConfig {
  return {
    provider: "tavily",
    endpoint: new URL("https://api.tavily.com/search"),
    apiKey,
    maxResults,
  };
}

/** https, or http for this machine only. The path /search is added. */
function searxngEndpoint(raw: string): URL | string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw}" is not a valid URL.`;
  }
  if (url.username !== "" || url.password !== "")
    return "a URL with a user name or password is not allowed.";
  const local = isLoopbackHost(url.hostname.replace(/^\[|\]$/g, ""));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return "use https (http only for localhost).";
  }
  return new URL(`${url.pathname.replace(/\/+$/, "")}/search`, url);
}

/** One search. `fetchFn` is the global fetch; tests replace it. */
export async function search(
  config: SearchConfig,
  query: string,
  maxResults: number,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<SearchResult[]> {
  const count = Math.min(Math.max(1, maxResults), MAX_RESULTS);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]);
  let request: Request;
  if (config.provider === "brave") {
    const url = new URL(config.endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    request = new Request(url, {
      headers: { accept: "application/json", "x-subscription-token": config.apiKey ?? "" },
    });
  } else if (config.provider === "tavily") {
    request = new Request(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey ?? ""}`,
      },
      body: JSON.stringify({ query, max_results: count, search_depth: "basic" }),
    });
  } else {
    const url = new URL(config.endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    request = new Request(url, { headers: { accept: "application/json" } });
  }
  let response: Response;
  try {
    response = await fetchFn(request, { signal: timeout, redirect: "error" });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(`${LABELS[config.provider]} did not answer: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? " Check the API key."
        : response.status === 429
          ? " Too many searches; wait, or check your plan."
          : "";
    throw new Error(`${LABELS[config.provider]} answered ${response.status}.${hint}`);
  }
  const text = await readCapped(response, SEARCH_MAX_BYTES);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `${LABELS[config.provider]} did not answer with JSON.${config.provider === "searxng" ? ' Turn on the "json" format in its settings.yml (search.formats).' : ""}`,
    );
  }
  return parseResults(config.provider, json).slice(0, count);
}

/** The results of one backend in one shape. Unknown fields are ignored. */
export function parseResults(provider: SearchProvider, json: unknown): SearchResult[] {
  const obj = (v: unknown) =>
    v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const list = provider === "brave" ? obj(obj(json).web).results : obj(json).results;
  if (!Array.isArray(list)) return [];
  const out: SearchResult[] = [];
  for (const item of list) {
    const r = obj(item);
    const url = str(r.url);
    if (!/^https?:\/\//.test(url)) continue;
    const snippet = provider === "brave" ? str(r.description) : str(r.content);
    const age = provider === "brave" ? str(r.age) : str(r.publishedDate);
    out.push({
      title: str(r.title),
      url,
      snippet,
      ...(age === "" ? {} : { age }),
    });
  }
  return out;
}

async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error(`The search answer is larger than ${max} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
