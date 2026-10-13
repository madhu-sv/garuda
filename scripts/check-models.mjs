#!/usr/bin/env node
// Release check (0.17): compare Garuda's Claude table (src/model/pricing.ts) with the Models API.
// A model that the API offers and the table does not know has no price in Garuda: its costs show
// as unknown. Run it before a release, with your own key in the environment:
//   ANTHROPIC_API_KEY=… pnpm models:check
// It sends only GET /v1/models (free). It exits 1 when the table misses a model.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The table's model ids, from the source text. */
export function tableIds(source) {
  return [...source.matchAll(/^\s*\[?\s*"(claude-[a-z0-9-]+)",/gm)].map((m) => m[1]);
}

/**
 * The API's ids that the table does not know (a dated id of a known model is known), and the
 * table's ids that the API no longer offers.
 */
export function compareIds(apiIds, table) {
  const known = (id) =>
    table.includes(id) ||
    table.some((t) => id.startsWith(`${t}-`) && /^\d{8}$/.test(id.slice(t.length + 1)));
  return {
    missing: apiIds.filter((id) => !known(id)),
    retired: table.filter((t) => !apiIds.some((id) => id === t || id.startsWith(`${t}-`))),
  };
}

async function main() {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  if (key === "") {
    console.error("Set ANTHROPIC_API_KEY in your environment (never in a file).");
    process.exit(2);
  }
  const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  const ids = [];
  let after;
  for (let page = 0; page < 10; page++) {
    const url = `${base}/v1/models?limit=1000${after === undefined ? "" : `&after_id=${encodeURIComponent(after)}`}`;
    const response = await fetch(url, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      redirect: "error",
    });
    if (!response.ok) {
      console.error(`The Models API answered HTTP ${response.status}.`);
      process.exit(2);
    }
    const body = await response.json();
    for (const m of body.data ?? []) if (typeof m.id === "string") ids.push(m.id);
    if (body.has_more !== true || typeof body.last_id !== "string") break;
    after = body.last_id;
  }
  const source = readFileSync(
    join(import.meta.dirname, "..", "src", "model", "pricing.ts"),
    "utf8",
  );
  const { missing, retired } = compareIds(ids, tableIds(source));
  console.log(`The API offers ${ids.length} models; the table knows ${tableIds(source).length}.`);
  for (const id of retired) console.log(`Not offered by the API any more (keep or remove): ${id}`);
  for (const id of missing) console.log(`MISSING in the table (no price, no thinking data): ${id}`);
  if (missing.length > 0) {
    console.log("Add them to KNOWN in src/model/pricing.ts with prices from the pricing page.");
    process.exit(1);
  }
  console.log("The table knows every model of the API.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
