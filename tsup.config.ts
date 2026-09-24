import { defineConfig } from "tsup";

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
    // Ink's layout engine uses top-level await, which CommonJS cannot bundle.
    // The binary keeps the plain chat: the CLI catches the failed import().
    esbuildOptions(options) {
      options.external = [...(options.external ?? []), "./chat/inkChat.js"];
    },
  },
]);
