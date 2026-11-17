import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The eval self-tests write projects and run their tests, so the suite is busy, and a slow test
    // elsewhere passed vitest's default 5 s on the user's machine (0.17: hard-rounding, then the
    // LSP reference sample). Every check run uses this limit, so `pnpm check` and the release
    // checks agree. A test that needs more sets its own.
    testTimeout: 30_000,
    // Only the project's own tests (2026-11): a copy of the repository inside the checkout
    // (output/current-review-checkout) ran its old tests too, and they failed.
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
