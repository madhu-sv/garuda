import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import config from "../vitest.config.js";
import { WAIT_UNTIL_MS } from "./helpers.js";

/** `pnpm check` must use the same test time limit as the release checks (0.17). */
it("every test gets 30 s unless it sets its own", () => {
  expect(config.test?.testTimeout).toBe(30_000);
});

it("waitUntil waits long enough on a busy machine, and ends before the test limit", () => {
  expect(WAIT_UNTIL_MS).toBeGreaterThanOrEqual(20_000);
  expect(WAIT_UNTIL_MS).toBeLessThan(config.test?.testTimeout ?? 5_000);
});

it("tests wait with waitUntil, not a copy with a shorter limit", () => {
  // The user's pnpm check (0.18.0): a local waitFor with 5 s failed the M5 Ctrl-C test when busy.
  const dir = import.meta.dirname;
  const copies = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && f !== "helpers.ts")
    .filter((f) => /function (waitFor|waitUntil)\(/.test(readFileSync(join(dir, f), "utf8")));
  expect(copies).toEqual([]);
});
