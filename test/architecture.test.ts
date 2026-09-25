import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

function imports(file: string): string[] {
  const code = readFileSync(file, "utf8");
  return [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
}

/** Imports that load code at run time: `import type` is erased and does not count. */
function valueImports(file: string): string[] {
  const code = readFileSync(file, "utf8");
  return [...code.matchAll(/^(?:import|export) (?!type )[^;]*?from\s+["']([^"']+)["']/gms)].map(
    (m) => m[1] ?? "",
  );
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

  it("app, evals and loop never import the CLI", () => {
    for (const folder of ["app", "evals", "loop", "context", "session"]) {
      for (const file of sourceFiles(join(SRC, folder))) {
        expect(
          imports(file).filter((spec) => spec.includes("/cli/")),
          file,
        ).toEqual([]);
      }
    }
  });

  it("startup does not load the Anthropic SDK or inquirer (N3)", () => {
    // Static imports load at startup. These two load with import() on first use.
    const heavy =
      /model\/anthropic\.js$|^@anthropic-ai\/|^@inquirer\/|mcp\/manager\.js$|^@modelcontextprotocol\/|model\/openaiCompatible\.js$/;
    const offenders = [...sourceFiles(join(SRC, "cli")), ...sourceFiles(join(SRC, "app"))].filter(
      (file) => valueImports(file).some((spec) => heavy.test(spec)),
    );
    expect(offenders).toEqual([]);
  });

  it("only the Ink chat imports Ink and React, and the CLI loads it with import() (N3)", () => {
    const inkFiles = [join(SRC, "cli", "chat", "inkChat.ts"), join(SRC, "cli", "chat", "ui.tsx")];
    const offenders = sourceFiles(SRC).filter(
      (file) =>
        !inkFiles.includes(file) &&
        imports(file).some((spec) => /^(ink|react)(\/|$)|\/inkChat\.js$|\/ui\.js$/.test(spec)),
    );
    expect(offenders).toEqual([]);
  });

  it("only src/mcp uses the MCP SDK, and never its own stdio transport (N8: the Executor starts servers)", () => {
    const offenders = sourceFiles(SRC).filter((file) => {
      const specs = imports(file).filter((spec) => spec.startsWith("@modelcontextprotocol/"));
      if (specs.length === 0) return false;
      return !file.includes(join(SRC, "mcp")) || specs.some((spec) => spec.endsWith("/stdio"));
    });
    expect(offenders).toEqual([]);
  });

  it("no module loads TypeScript 6 at startup: only import() and type imports (N3)", () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      /^import (?!type )[^;]*from ["']ts6["']/m.test(readFileSync(file, "utf8")),
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
