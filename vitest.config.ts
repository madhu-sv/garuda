import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The eval self-tests write projects and run their tests, so the suite is busy, and a slow test
    // elsewhere passed vitest's default 5 s on the user's machine (0.17: hard-rounding, then the
    // LSP reference sample). Every check run uses this limit, so `pnpm check` and the release
    // checks agree. A test that needs more sets its own.
    testTimeout: 30_000,
  },
});
