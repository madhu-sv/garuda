import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enginesRange, NODE_SECURITY, nodeProblem } from "../src/nodeFloor.js";

const root = join(import.meta.dirname, "..");

describe("Node security floor (0.17)", () => {
  it("warns for a Node without the latest fixes, and for a line with no fixes", () => {
    expect(nodeProblem("22.23.3")).toMatch(/does not have the security fixes of 2026-10-21/);
    expect(nodeProblem("22.23.3")).toContain("Update to 22.23.4 or later");
    expect(nodeProblem("24.22.0")).toContain("24.22.1");
    expect(nodeProblem("26.12.0")).toContain("26.12.1");
    expect(nodeProblem("v22.9.0")).toBeDefined();
    expect(nodeProblem("20.19.0")).toMatch(/gets no security fixes/);
    expect(nodeProblem("23.11.0")).toMatch(/gets no security fixes/);
    expect(nodeProblem("25.9.0")).toMatch(/gets no security fixes/);
  });

  it("accepts the fixed releases, later ones, and a line newer than the table", () => {
    for (const v of ["22.23.4", "22.24.0", "24.22.1", "24.23.0", "26.12.1", "26.13.0", "28.0.0"]) {
      expect(nodeProblem(v)).toBeUndefined();
    }
  });

  it("package.json engines and the CI check use the same table", async () => {
    // @ts-expect-error: a plain .mjs script with no types.
    const { floors, problem } = await import("../scripts/check-node.mjs");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.engines.node).toBe(enginesRange());
    expect(enginesRange()).toBe("^22.23.4 || ^24.22.1 || >=26.12.1");
    const table = floors(readFileSync(join(root, "src", "nodeFloor.ts"), "utf8"));
    expect(table).toEqual(
      Object.fromEntries(Object.entries(NODE_SECURITY.lines).map(([k, v]) => [k, v])),
    );
    expect(problem("22.23.3", table)).toMatch(/older than 22.23.4/);
    expect(problem("25.9.0", table)).toMatch(/not a line/);
    expect(problem("22.23.4", table)).toBeUndefined();
    expect(problem("24.30.0", table)).toBeUndefined();
  });
});
