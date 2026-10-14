# MCP, web and code intelligence

MCP servers, web fetch and search, the code index, language plugins, LSP diagnostics, formatters.

## MCP servers

Garuda connects to local MCP servers over stdio (0.2) and to remote servers over Streamable HTTP,
with OAuth sign-in (0.4).

```json
{
  "servers": {
    "github": {
      "command": "github-mcp-server",
      "args": ["stdio"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
      "network": true
    }
  }
}
```

- Your own servers go in `~/.garuda/mcp.json`. A project can add servers in `.garuda/mcp.json`.
- Keys per server: `command`, `args`, `env`, `network` (default false), `writePaths`,
  `timeoutMs` (default 60000), `enabled`. `${NAME}` in an env value comes from your environment,
  so secrets stay out of the file.
- Servers start with the first task. `/mcp` shows their state.
- A remote server needs only its URL: `"linear": { "url": "https://mcp.linear.app/mcp" }`. When it
  asks for a sign-in, Garuda asks you, opens your browser, and keeps the tokens in
  `~/.garuda/mcp-auth.json` (only you can read it). Tokens refresh by themselves;
  `/mcp logout <server>` removes them.

Security:

- A project server can come from a cloned repo, so Garuda asks before it starts one. The question
  shows the full command, the sandbox, the network setting, the env variables and warnings
  (npx, shell commands, secrets). "Remember" pins your answer to a hash of the definition in
  `~/.garuda/trust.json`; any change asks again. A project cannot replace one of your own servers.
- A remote server is not in the sandbox: it runs on another computer and gets the arguments of its
  tool calls. A project's remote server needs your consent (pinned to its URL), must use https and a
  public address, and Garuda checks the address at each connection.
- Each local server runs in the OS sandbox, like bash: it can write only in the project and temp folders,
  cannot read `~/.ssh` and other secrets, and has no network unless `"network": true`.
  It gets only the normal environment variables and the ones in its `env`.
- Garuda remembers each server's tools (a hash per tool). When they change later (a "rug pull"),
  Garuda warns you and says which tools were added, removed or changed, with the new descriptions.
  A project server needs your consent again.
- When a configured server is not available (you said no, it failed or it stopped), Garuda tells
  the model once in a `<garuda_note>`, so the model says so instead of guessing. Server text cannot
  pose as such a note or close its `<mcp_result>` wrapper.
- An MCP tool call asks for approval and shows its arguments, unless an allow rule covers it. Server hints such as
  `readOnlyHint` are shown, never trusted. Allow rules skip the question:
  `mcp__github__get_issue` or `mcp__github__*`.
- Tool names get the prefix `mcp__<server>__`, so a server cannot replace a Garuda tool.
- Descriptions and results are cleaned (terminal escape codes, control, invisible and Unicode tag
  characters), limited in size, and marked as untrusted for the model (`<mcp_result>`).
- Garuda offers no sampling, roots or elicitation, so a server cannot make model calls or ask
  you questions through Garuda.
- The evals never start MCP servers.

## Web fetch

`web_fetch` reads a web page (http or https) and gives it to the model as Markdown (0.2).

- The first fetch from a host asks you and shows the full URL. "Yes, allow <host> for this session"
  skips later questions for that host. Rules skip the question for good:
  `web_fetch(docs.python.org)`, or `web_fetch(*.github.com)` for its subdomains.
- An unusual URL (very long, or with a long token that could carry data from the session) always asks,
  also for an allowed host.
- A redirect to another host asks like a new fetch.
- Protection against server-side request forgery: Garuda resolves each host itself, checks every
  address (only public addresses; no private, loopback, link-local such as 169.254.169.254, or other
  special ranges, also as IPv4-mapped IPv6), and connects to exactly the checked address. Redirects
  are followed by hand (at most 5) and checked the same way.
- http is upgraded to https. URLs with a user name or password are refused. Garuda sends no cookies
  and no credentials, and it does not use a proxy.
- Limits: 5 MB per page (also after decompression), 30 s, text types only. HTML becomes Markdown
  without scripts, styles and navigation. Long pages come in parts (`start`, `max_chars`); a page is
  cached for 10 minutes.
- Page text is cleaned like MCP text and marked as untrusted (`<web_result>`).
- Settings: `"web": { "enabled": false }` removes the tool. `"web": { "allowLocalhost": true }` allows
  loopback addresses (for a local docs server); private network ranges stay blocked.
- The evals turn web_fetch off.

## Web search

`web_search` finds pages for a query (0.5). Set a key and it appears:

```sh
export BRAVE_API_KEY=...       # Brave Search, or:
export TAVILY_API_KEY=...      # Tavily
```

Or pick a backend in `~/.garuda/search.json`: `{ "provider": "brave" }`, `{ "provider": "tavily" }`, or
your own SearXNG server: `{ "provider": "searxng", "url": "http://localhost:8888" }` (turn on its JSON
format). Keys come only from environment variables; a project cannot configure search.

- The query leaves your machine, so each search shows the query and asks. "Yes, for this session" skips
  the question for later searches; `"permissions": { "allow": ["web_search"] }` skips it for good (and allows
  searches in plan mode).
- A query with a long token (it could be a key) is refused.
- Results are titles, URLs and short texts, marked as untrusted. The model reads pages with `web_fetch`.
- `"web": { "enabled": false }` removes both web tools. Details: [docs/lld/web.md](../lld/web.md).

### Claude's web search (0.6)

With a Claude model, the model can use Claude's own search tool, which runs on Anthropic's servers. Turn it
on with a `claude` section in `~/.garuda/search.json`:

```json
{ "claude": { "maxUses": 5 } }
{ "provider": "tavily", "claude": { "blockedDomains": ["example.com"] } }
```

- The search runs inside the model's reply, so Garuda cannot ask before each query. Choose once which
  web search you want, with `"use"` in `~/.garuda/search.json`: `"claude"` (Claude's search; your other
  backend stays the fallback for other models), `"provider"` (only your other backend) or `"off"`.
  `garuda init` asks it when Claude's search is set up and nothing is saved; without a saved choice,
  the chat asks once before the first task and saves the answer. No session asks again.
- `/search` shows what is in use. `/search claude|provider|off` switches for this session;
  `/search default claude|provider|off` changes the saved choice.
- It costs $10 per 1,000 searches, on top of the tokens. The usage line and `/usage` include it.
- `maxUses` (1–20, default 5) caps the searches per model request. `allowedDomains` or `blockedDomains`
  (not both) limit the sites.
- Your other backend (`provider`, or a key in the environment) is the fallback: for a model that is not a
  Claude model (for example after `/models`), or with `"use": "provider"`. Without one, `provider` is
  not offered.
- Custom agents whose tools allow `WebSearch` (or `web_search`) get it too, in the same session.
- The chat shows each search: `● web_search (Claude) <query>` and the number of results; Ctrl-O lists
  the pages.

## Code index and dynamic language plugins (local knowledge)

Garuda keeps a local code index with a dynamic language plugin architecture (0.16).
It answers code questions on this machine, with zero native C++ compilation dependencies and no model call:

- Built-in language plugins: TypeScript/JavaScript, Python, Java, Go, and Rust.
- Dynamic plugin system:
  - User plugins: Drop custom language experts in `~/.garuda/languages/<lang>.js`.
  - Project plugins (`<root>/.garuda/languages/`) are not loaded (merge gate). A plugin runs inside
    Garuda's own process with no sandbox, there is no consent flow yet, and a hash pin of the entry file
    does not cover the files it imports (G09). `/languages` names the plugins that were skipped.
  - Tests and evals load the built-in experts only.
- Tools for the agent (read-only, no approval), chosen with `"codeIndex"` in `.garuda/settings.json`:
  `"off"` (default), `"lookup"` (`find_symbol`, `find_references`, `find_callers`, `impact_analysis`, `ast_query`) or `"all"` (also `repo_map`).
  `find_callers` groups indexed reference sites by their enclosing symbol; `impact_analysis` estimates dependents, blast radius and affected tests (including Go `*_test.go` and Rust `*_test.rs`); `ast_query` filters symbols by kind, container, and wildcards.
  Java, Python, Go and Rust references use identifier matching, and Garuda cannot vouch for a user
  plugin. Their references, callers and impact results are
  marked **Approximate**, including empty results: matching can include unrelated symbols and miss
  aliases or dynamic uses. Check with a compiler or language server before a rename. These tools do
  not run jdtls or pyright. The [fixed 60-query measurement](../quality-baseline/code-intelligence-baseline.md)
  records Java precision/recall **61.1%/91.7%**, Python **71.4%/93.8%**, against frozen language-server
  reference results. So about 2 in 5 Java hits and 3 in 10 Python hits were not real references. The
  recall counts only the reference patterns in this generated sample (30 queries per language, one
  capture, Linux); aliases, dynamic dispatch and real-repository layouts can lower it. This sample does
  not establish accuracy on your repository.
- Chat commands for you: `/where X` (or `/defs X`), `/refs X`, `/callers X`, `/impact X`, `/map [folder]`, and `/languages` (lists active language plugins, indexed file counts, and standby status).
- The code graph (files, exports, imports) is cached in `.garuda/index/code-graph.json` by file hash.
  Experts run in-process and preserve single-binary distribution; outside JS/TS, declaration extraction
  and reference matching use heuristics.
- Files follow `.gitignore`. Sensitive files are never indexed.

## LSP diagnostics (opt-in)

With `garuda --lsp`, or `"lsp": { "enabled": true }` in `.garuda/settings.json`, a language server checks
each file that `edit_file` or `write_file` changes, and the result lists its errors:

```
Edited src/cart.ts.

1 error in src/cart.ts after this change (tsc):
  14:7 Type 'string' is not assignable to type 'number'. [2322]
```

- TS/JS: TypeScript 7 (`tsc --lsp`), `tsgo` or `typescript-language-server`. Python: basedpyright or
  pyright. Java: jdtls (it needs Java 21 or later; `JAVA_HOME` or a usual JDK folder). For a Maven or
  Gradle project, jdtls starts with the first task, because its project import takes a while.
- Garuda uses a server on your PATH (for Java also `brew install jdtls`), or its own copy:
  `garuda lsp install typescript` (or `python`, `java`) installs a pinned version into `~/.garuda/lsp/`. With `{ "autoInstall": true }` in
  `~/.garuda/lsp.json`, Garuda asks to install a missing server at the first edit.
- `garuda lsp` (or `/lsp` in the chat) shows the servers and their state.
- Servers run only in the OS sandbox: the project is read-only for them, and they have no network. A
  missing, slow or broken server never blocks an edit.
- Off by default: in the A/B eval on the hard suite the model made no type errors, so LSP had nothing to
  catch. Measure it again with `garuda eval -s hard --repeat 3 --lsp on`.

## Formatters (opt-in)

With `"formatters": { "enabled": true }` in `.garuda/settings.json`, Garuda runs the project's own
formatter on each file that `edit_file` or `write_file` changes, and the result shows what it changed:

```
Edited src/cart.ts.
Formatted with prettier:
-  const total=items.reduce((s,i)=>s+i.price,0)
+  const total = items.reduce((s, i) => s + i.price, 0);
```

- It finds Biome or Prettier (their config and `node_modules/.bin`), ruff or black (`pyproject.toml`,
  a venv or PATH), gofmt (`go.mod`) and rustfmt (`Cargo.toml`). It never installs a formatter.
- `"commands"` changes the list: `{ "prettier": false }` turns one off; `{ "mine": { "extensions":
  ["txt"], "command": ["fmt", "$FILE"] } }` adds one or replaces a detected one.
- Formatters run only in the OS sandbox, like the model's commands. A failed formatter adds a note; it
  never undoes the edit.
- Off by default until measured: `garuda eval -s hard --repeat 3 --format on` (and `--format off`).
