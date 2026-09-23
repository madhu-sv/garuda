import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

function imports(file: string): string[] {
  const code = readFileSync(file, "utf8");
  return [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
}

describe("architecture rules", () => {
  it("the loop never imports the CLI", () => {
    for (const file of sourceFiles(join(SRC, "loop"))) {
      expect(
        imports(file).filter((spec) => spec.includes("/cli/")),
        file,
      ).toEqual([]);
    }
  });

  it("only the model adapter imports the Anthropic SDK (N1)", () => {
    const offenders = sourceFiles(SRC).filter(
      (file) =>
        !file.endsWith(join("model", "anthropic.ts")) &&
        imports(file).some((spec) => spec.startsWith("@anthropic-ai/")),
    );
    expect(offenders).toEqual([]);
  });

  it("only src/sandbox starts processes (N8)", () => {
    const offenders = sourceFiles(SRC).filter(
      (file) =>
        !file.includes(`${join(SRC, "sandbox")}`) &&
        imports(file).some((spec) => /^(node:)?child_process$|^execa$/.test(spec)),
    );
    expect(offenders).toEqual([]);
  });
});
