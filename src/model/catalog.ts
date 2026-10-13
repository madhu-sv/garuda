import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { knownModels, type ModelInfo } from "./pricing.js";

/**
 * The Anthropic models that the user's key can use (0.17): `GET /v1/models`, all pages. Garuda's
 * own table (pricing.ts) has the prices; the Models API has none. A model that the table does not
 * know still shows in the picker, with its context window from the API and "price unknown".
 *
 * Garuda fetches the list only in `garuda setup` (it has the key at hand) and keeps it in
 * ~/.garuda/cache/anthropic-models.json. The chat reads that file; it never calls the network for
 * the list. A list older than CATALOG_MAX_AGE_MS is still shown, and setup fetches it again.
 */

export interface CatalogModel {
  id: string;
  displayName?: string;
  /** The API's max_input_tokens. */
  contextWindow?: number;
}

export interface Catalog {
  fetchedAt: string;
  models: CatalogModel[];
}

export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGES = 10;

export function catalogPath(home: string = homedir()): string {
  return join(home, ".garuda", "cache", "anthropic-models.json");
}

/** The list from the API, or a reason. One request per page, at most 10 pages. */
export async function fetchCatalog(options: {
  key: string | undefined;
  baseUrl?: string;
  fetcher?: typeof fetch;
  now?: Date;
}): Promise<{ catalog: Catalog } | { problem: string }> {
  const fetcher = options.fetcher ?? fetch;
  const base = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (options.key !== undefined) headers["x-api-key"] = options.key;
  const models: CatalogModel[] = [];
  let after: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${base}/v1/models?limit=1000${after === undefined ? "" : `&after_id=${encodeURIComponent(after)}`}`;
      const response = await fetcher(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { problem: `the Models API answered HTTP ${response.status}` };
      }
      const body = (await response.json()) as {
        data?: { id?: unknown; display_name?: unknown; max_input_tokens?: unknown }[];
        has_more?: unknown;
        last_id?: unknown;
      };
      for (const m of body.data ?? []) {
        if (typeof m.id !== "string" || !/^[A-Za-z0-9._:-]+$/.test(m.id)) continue;
        models.push({
          id: m.id,
          ...(typeof m.display_name === "string" ? { displayName: m.display_name } : {}),
          ...(typeof m.max_input_tokens === "number" && m.max_input_tokens > 0
            ? { contextWindow: m.max_input_tokens }
            : {}),
        });
      }
      if (body.has_more !== true || typeof body.last_id !== "string") break;
      after = body.last_id;
    }
  } catch (error) {
    return { problem: `Garuda could not read the Models API (${(error as Error).message})` };
  }
  return { catalog: { fetchedAt: (options.now ?? new Date()).toISOString(), models } };
}

export async function saveCatalog(catalog: Catalog, home: string = homedir()): Promise<void> {
  const path = catalogPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
}

/** The saved list, or undefined (none, or not readable). */
export async function loadCatalog(home: string = homedir()): Promise<Catalog | undefined> {
  try {
    const data = JSON.parse(await readFile(catalogPath(home), "utf8")) as Catalog;
    if (typeof data.fetchedAt !== "string" || !Array.isArray(data.models)) return undefined;
    return {
      fetchedAt: data.fetchedAt,
      models: data.models.filter((m) => typeof m?.id === "string"),
    };
  } catch {
    return undefined;
  }
}

/**
 * The picker's Anthropic models: the API's list (when there is one) in its order, each with
 * Garuda's table entry when it knows the model; then the table's models that the list does not
 * have. A model that Garuda does not know has no price.
 */
export function mergedModels(
  catalog: Catalog | undefined,
): { id: string; info: ModelInfo; known: boolean }[] {
  const table = knownModels();
  const exact = new Map(table.map((m) => [m.id, m.info]));
  const out: { id: string; info: ModelInfo; known: boolean }[] = [];
  for (const m of catalog?.models ?? []) {
    const info = exact.get(m.id) ?? prefixInfo(m.id);
    if (info !== undefined) out.push({ id: m.id, info, known: true });
    else out.push({ id: m.id, info: { contextWindow: m.contextWindow ?? 200_000 }, known: false });
  }
  for (const m of table) {
    if (!out.some((o) => o.id === m.id)) out.push({ id: m.id, info: m.info, known: true });
  }
  return out;
}

/** A dated id of a known model (claude-haiku-4-5-20251001): the table's entry for its prefix. */
function prefixInfo(id: string): ModelInfo | undefined {
  let best: { id: string; info: ModelInfo } | undefined;
  for (const m of knownModels()) {
    if (id.startsWith(`${m.id}-`) && /^\d{8}$/.test(id.slice(m.id.length + 1))) {
      if (m.id.length > (best?.id.length ?? 0)) best = m;
    }
  }
  return best?.info;
}
