import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeError, greeting } from "../src/cli/greeting.js";
import { VERSION } from "../src/version.js";

describe("CLI helpers", () => {
  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });

  it("the greeting names Garuda and its version", () => {
    expect(greeting()).toContain(`Garuda ${VERSION}`);
    expect(greeting()).toContain("garuda -p");
  });

  it("describeError shows the cause chain and error codes", () => {
    const root = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const error = new Error("Connection error.", { cause: root });
    expect(describeError(error)).toBe(
      "Connection error.\n  caused by: socket hang up (ECONNRESET)",
    );
    expect(describeError("plain")).toBe("plain");
  });
});
