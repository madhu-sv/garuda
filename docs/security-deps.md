# Node and dependency security

Garuda fetches untrusted pages and talks to MCP servers. So the Node runtime and the npm packages
that handle that data must have their security fixes. Garuda must not carry a known vulnerability
to its users. This page says how the project keeps to that (0.17).

## Node

- [src/nodeFloor.ts](../src/nodeFloor.ts) holds the release with the latest security fixes for
  each supported line: 22.23.4, 24.22.1 and 26.12.1 (the Node.js security release of
  2026-10-21). Odd lines (23, 25) and lines before 22 get no fixes.
- Garuda warns on stderr at start when its Node is older than the entry for its line, or on a line
  with no fixes. It still runs: a user may need a day to update.
- `engines.node` in package.json names the same versions. npm and pnpm warn on install.
- Every workflow (CI, audit, release, website) asks `setup-node` for the newest release of its line
  (`check-latest: true`), not an older one on the runner image. Then
  `node scripts/check-node.mjs` stops the job when that Node is older than the table. So no
  release is built, tested or published with a Node that misses fixes.
- `pnpm package` builds the standalone binary, which holds Node itself. It refuses a Node that
  misses fixes.

With each Node.js security release (announced at
[nodejs.org/en/blog/vulnerability](https://nodejs.org/en/blog/vulnerability)):

1. Wait until the fixed versions are out (the announcement comes a week before).
2. Update the table, the date and the link in `src/nodeFloor.ts`, and `engines.node` in
   package.json (a test checks that they match).
3. Update the versions named in README.md, CONTRIBUTING.md, the user guide and the website's
   install page.
4. Release a patch version, so the start warning reaches users.

## npm packages

- The **Audit** workflow runs `pnpm audit` on each push, each pull request and each Monday. Any
  advisory in a shipped dependency fails it; a high or critical one in a build tool or in the
  website fails it too.
- Dependabot opens update pull requests each week for npm (package and website) and for the
  pinned GitHub Actions (each pinned to a full commit hash, with the tag in a comment; all run on
  Node 24). Turn on **Dependabot security updates** in the repository settings
  (Settings, Code security), so a security fix comes at once.

## Exceptions

An advisory with no fixed version may be ignored only with a reason and a defence in Garuda. Each
one is in `pnpm.auditConfig.ignoreGhsas` in package.json and in this table.

| Advisory | Package | Why Garuda is safe |
| --- | --- | --- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `braces` (through globby, micromatch) | No fixed version. A model pattern reached it through `glob` and `grep`: `{a,b}` 1900 times ran Node out of memory, and a deep nesting overflowed the stack. `assertSafePattern` (src/tools/files.ts) now refuses a pattern that brace expansion makes into more than 1000 patterns, or that nests `{…}` more than 10 deep. The team policy's `denyPaths` reach `braces` too; they come from the administrator, not the model. |

## 0.17 updates

- `@modelcontextprotocol/client` 2.1.0 → 2.3.1: GHSA-6qxp-vccf-f47h (high, the OAuth client could
  send credentials to an authorization server that the MCP server chose) and GHSA-6prh-2h8m-c8cw
  (moderate, HTTP transports followed cross-origin redirects with custom headers and bodies).
  Garuda uses this transport and OAuth for remote MCP servers.
- `undici` 7.30.0 → 7.30.1 (Garuda's Claude client).
- `zod` 4.6.5 → 4.6.7: GHSA-mrhx-c7xc-m3w5 (high), one oversized array made one issue per element
  and could run Node out of memory. zod checks the model's tool input and the MCP SDK's messages
  from servers. The Audit workflow found it on its first run.
- Build and test tools: `@modelcontextprotocol/server` 2.3.1 (tests only), vite 8.3.5, esbuild
  0.28 (override), `source-map-js` 1.2.2; the website's astro, starlight and mermaid.
