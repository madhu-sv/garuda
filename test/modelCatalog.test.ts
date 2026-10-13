import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type Choice, type SetupIO, setupCommand } from "../src/cli/setupCommand.js";
import {
  catalogPath,
  fetchCatalog,
  loadCatalog,
  mergedModels,
  saveCatalog,
} from "../src/model/catalog.js";
import { aliasModel, costOf, lookupModel } from "../src/model/pricing.js";
import type { Usage } from "../src/model/types.js";

/** New Claude models and the account's model list (0.17). Temporary homes only. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-catalog-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let count = 0;
const home = () => join(base, `h${count++}`);
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
});

describe("the October 2026 models", () => {
  it("Sonnet 5.5 and Haiku 5.5 are known, with their prices and 1M context; aliases name them", () => {
    const sonnet = lookupModel("claude-sonnet-5-5");
    expect(sonnet.price).toMatchObject({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    expect(sonnet.contextWindow).toBe(1_000_000);
    expect(lookupModel("claude-haiku-5-5").contextWindow).toBe(1_000_000);
    // The older Sonnet 5 keeps its own price (longest prefix wins).
    expect(lookupModel("claude-sonnet-5").price?.input).toBe(2);
    expect(lookupModel("claude-sonnet-5").price?.cacheRead).toBe(0.2);
    expect(aliasModel("sonnet")).toBe("claude-sonnet-5-5");
    expect(aliasModel("haiku")).toBe("claude-haiku-5-5");
  });

  it("Haiku 5.5: a prompt over 100,000 tokens pays the higher prices for all its tokens", () => {
    const price = lookupModel("claude-haiku-5-5").price;
    if (price === undefined) throw new Error("no price");
    // 100,000 prompt tokens: the low level.
    expect(costOf(usage(100_000, 1_000_000), price)).toBeCloseTo(0.01 + 0.5, 10);
    // 100,001 (cache reads count): the high level for everything.
    expect(costOf(usage(50_001, 1_000_000, 50_000), price)).toBeCloseTo(
      (50_001 * 0.5 + 50_000 * 0.05) / 1e6 + 2.5,
      10,
    );
  });
});

const page = (data: object[], more = false, last?: string) => ({
  data,
  has_more: more,
  ...(last === undefined ? {} : { last_id: last }),
});

describe("the account's model list", () => {
  it("reads every page, keeps ids and context windows, and skips odd ids", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string | URL) => {
      urls.push(String(url));
      const body = String(url).includes("after_id")
        ? page([{ id: "claude-new-6", max_input_tokens: 2_000_000 }])
        : page(
            [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }, { id: "bad id" }],
            true,
            "claude-sonnet-5-5",
          );
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const result = await fetchCatalog({ key: "k", fetcher, now: new Date(0) });
    if ("problem" in result) throw new Error(result.problem);
    expect(result.catalog.models).toEqual([
      { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" },
      { id: "claude-new-6", contextWindow: 2_000_000 },
    ]);
    expect(urls[1]).toContain("after_id=claude-sonnet-5-5");
  });

  it("an error answer is a problem, not an empty list", async () => {
    const fetcher = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    expect(await fetchCatalog({ key: "k", fetcher })).toEqual({
      problem: "the Models API answered HTTP 401",
    });
  });

  it("merge: the account's models first; an unknown one has no price; the table's rest after", () => {
    const merged = mergedModels({
      fetchedAt: "x",
      models: [
        { id: "claude-new-6", contextWindow: 2_000_000 },
        { id: "claude-haiku-4-5-20251001" },
        { id: "claude-sonnet-5-5" },
      ],
    });
    expect(merged[0]).toEqual({
      id: "claude-new-6",
      info: { contextWindow: 2_000_000 },
      known: false,
    });
    expect(merged[1]?.known).toBe(true);
    expect(merged[1]?.info.price?.input).toBe(1);
    expect(merged[2]?.info.price?.input).toBe(2);
    expect(merged.some((m) => m.id === "claude-opus-5-5")).toBe(true);
    expect(mergedModels(undefined)[0]?.id).toBe("claude-sonnet-5-5");
  });

  it("saved under ~/.garuda/cache with 0600, and read back", async () => {
    const h = home();
    await saveCatalog({ fetchedAt: "2026-10-13T00:00:00.000Z", models: [{ id: "claude-x" }] }, h);
    expect(statSync(catalogPath(h)).mode & 0o777).toBe(0o600);
    expect((await loadCatalog(h))?.models).toEqual([{ id: "claude-x" }]);
    expect(await loadCatalog(home())).toBeUndefined();
  });

  it("setup with a key in the environment lists the account's models, saves them, marks unknown prices", async () => {
    const h = home();
    const answers: unknown[] = ["anthropic", "claude-new-6", false];
    const choices: { name: string; value: string; description?: string }[][] = [];
    const printed: string[] = [];
    const io: SetupIO = {
      interactive: true,
      select: async <T>(_m: string, list: Choice<T>[]) => {
        choices.push(list as unknown as { name: string; value: string; description?: string }[]);
        return answers.shift() as T;
      },
      input: async () => answers.shift() as string,
      secret: async () => answers.shift() as string,
      confirm: async () => answers.shift() as boolean,
      print: (text: string) => {
        printed.push(text);
      },
    };
    const fetcher = (async () =>
      new Response(JSON.stringify(page([{ id: "claude-new-6" }, { id: "claude-sonnet-5-5" }])), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(
      await setupCommand({}, { io, home: h, env: { ANTHROPIC_API_KEY: "sk-env" }, fetch: fetcher }),
    ).toBe(0);
    expect(printed).toContain("Models of your account: 2.");
    const models = choices[1] ?? [];
    expect(models[0]?.value).toBe("claude-new-6");
    expect(models[0]?.description).toContain("price unknown");
    expect(models[1]?.description).toBe("$2 in, $10 out per million tokens");
    expect(JSON.parse(readFileSync(catalogPath(h), "utf8")).models).toHaveLength(2);
  });
});

describe("the release check (scripts/check-models.mjs)", () => {
  it("finds the table's ids and the models it misses", async () => {
    // @ts-expect-error: a plain .mjs script with no types.
    const script = await import("../scripts/check-models.mjs");
    const source = readFileSync(
      join(import.meta.dirname, "..", "src", "model", "pricing.ts"),
      "utf8",
    );
    const table: string[] = script.tableIds(source);
    expect(table).toContain("claude-sonnet-5-5");
    expect(table).toContain("claude-haiku-5-5");
    expect(table).toContain("claude-haiku-4-5");
    expect(
      script.compareIds(["claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-new-6"], table),
    ).toMatchObject({
      missing: ["claude-new-6"],
    });
  });
});
