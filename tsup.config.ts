import { execFileSync } from "node:child_process";
import { defineConfig } from "tsup";

/** The commit that the build comes from (src/buildInfo.ts); empty outside a git checkout. */
function headCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
const define = { __GARUDA_BUILD_COMMIT__: JSON.stringify(headCommit()) };

export default defineConfig([
  // Normal build: `node dist/cli/index.js`. Dependencies stay in node_modules.
  {
    entry: { "cli/index": "src/cli/index.ts" },
    format: ["esm"],
    target: "node22",
    platform: "node",
    outDir: "dist",
    clean: true,
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
    define,
  },
  // Single-file bundle for the standalone binary (scripts/package.mjs).
  // Node single executable applications run one CommonJS file, so every dependency goes in.
  {
    entry: { garuda: "src/cli/index.ts" },
    format: ["cjs"],
    target: "node24",
    platform: "node",
    outDir: "dist-sea",
    clean: true,
    noExternal: [/.*/],
    minify: true,
    define,
    // Ink's layout engine uses top-level await, which CommonJS cannot bundle.
    // The binary keeps the plain chat: the CLI catches the failed import().
    esbuildOptions(options) {
      options.external = [...(options.external ?? []), "./chat/inkChat.js"];
    },
  },
]);
