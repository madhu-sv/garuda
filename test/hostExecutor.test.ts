import { describe, expect, it } from "vitest";
import { HostExecutor } from "../src/sandbox/host.js";
import { createExecutor } from "../src/sandbox/index.js";
import { executorContract } from "./executorContract.js";

executorContract("host", () => new HostExecutor());

describe("createExecutor", () => {
  it('builds the host executor from the config key "host"', () => {
    const executor = createExecutor("host");
    expect(executor).toBeInstanceOf(HostExecutor);
    expect(executor.isolation).toBe("none");
  });
});
