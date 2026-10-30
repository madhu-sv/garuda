import { expect, it } from "vitest";
import config from "../vitest.config.js";

/** `pnpm check` must use the same test time limit as the release checks (0.17). */
it("every test gets 30 s unless it sets its own", () => {
  expect(config.test?.testTimeout).toBe(30_000);
});
