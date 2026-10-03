import { describe, expect, it } from "vitest";
import { RegexMatcher } from "../src/tools/regexWorker.js";

/** grep's regular expression runs in a worker (0.14.1, from Garuda's tools review). */
describe("RegexMatcher", () => {
  it("gives the matching line indexes", async () => {
    const matcher = new RegexMatcher("coupon", "i", new AbortController().signal);
    try {
      expect(await matcher.match(["a", "applyCoupon()", "b", "COUPON"], "x.ts")).toEqual([1, 3]);
      expect(await matcher.match(["none"], "y.ts")).toEqual([]);
    } finally {
      matcher.close();
    }
  });

  it("stops a pattern that backtracks badly, and Garuda stays responsive", async () => {
    const matcher = new RegexMatcher("(a+)+$", "", new AbortController().signal, 300);
    const started = Date.now();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    try {
      await expect(matcher.match([`${"a".repeat(40)}b`], "slow.txt")).rejects.toThrow(
        /took more than 0.3 s on slow\.txt/,
      );
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    // The event loop ran while the worker was busy.
    expect(ticks).toBeGreaterThan(3);
  });

  it("stops at Ctrl-C", async () => {
    const controller = new AbortController();
    const matcher = new RegexMatcher("(a+)+$", "", controller.signal, 60_000);
    const pending = matcher.match([`${"a".repeat(40)}b`], "slow.txt");
    setTimeout(() => controller.abort(new Error("stopped")), 100);
    await expect(pending).rejects.toThrow("stopped");
  });
});
