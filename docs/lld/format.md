# Formatters after edits (`src/format/`, 0.10)

## Purpose

Run the project's own formatter on each file that `edit_file` or `write_file` changes, so the code
keeps the project's style without a separate step. Off by default until an A/B run shows no harm.

## Detection (`formatters.ts`)

`detectFormatters(root, PATH, settings)` only reads files; nothing runs. A formatter needs its config
and a binary that is already there; Garuda never installs one.

| Formatter | Config | Binary | Extensions |
| --- | --- | --- | --- |
| biome | `biome.json`, `biome.jsonc` | `node_modules/.bin/biome` | js, jsx, mjs, cjs, ts, tsx, mts, cts, json, jsonc, css |
| prettier | `.prettierrc*`, `prettier.config.*`, `"prettier"` in package.json | `node_modules/.bin/prettier` | the JS ones, json, css, scss, less, md, yaml, yml, html, vue |
| ruff | `[tool.ruff` in pyproject.toml, `ruff.toml`, `.ruff.toml` | `.venv/bin`, `venv/bin`, PATH | py, pyi |
| black | `[tool.black` in pyproject.toml | `.venv/bin`, `venv/bin`, PATH | py, pyi |
| gofmt | `go.mod` | PATH | go |
| rustfmt | `Cargo.toml` (its `edition`, default 2021) | PATH | rs |

The first formatter that takes an extension wins (Biome before Prettier, ruff before black).
`formatters.commands` in settings changes the list: a name with `false` turns a detected formatter
off; a name with `{ "extensions", "command" }` adds a formatter or replaces a detected one, and comes
first. `"$FILE"` in the command is the file's absolute path; `formatCommand` quotes each word.

## Running (`app/runtime.ts`, `tools/types.ts`)

- `settings.formatters.enabled` (default false) turns it on; the runtime then passes `format` to the
  loop, which puts it in the `ToolContext`. It runs only with an OS sandbox: a formatter is a project
  command, like the model's bash, so it gets the same policy (`execPolicy`, the project writable, no
  network) and a 20 s limit. Detection runs at the first edit and is kept for the process.
- `afterWrite(result, context, file)` (edit_file and write_file): write, record, format, then LSP
  diagnostics on the formatted text. When the formatter changed the file, the file counts as read in
  its new form (`files.record`), and the result shows the formatter's diff (up to 30 lines; else a note
  to read the file again), so the model's next `old_string` matches. A failed or slow formatter adds a
  note ("ruff could not format it: exit code 2: …"); it never fails the edit.

## Measuring (`garuda eval --format on|off`)

Result (2026-09-29, hard suite, claude-sonnet-5, 3 runs per task): on 18/18, 141 steps, $0.6834, 84% of
tokens from the cache, 84 s; off 18/18, 144 steps, $0.5974, 87%, 73 s. About 14% more cost with no
gain in steps or passes, so formatters stay off by default. A shorter note in place of the diff may
cost less; it needs its own A/B.


The eval projects have no formatter, so the A/B brings one: Garuda's own Biome (a dev dependency; a
source checkout after `pnpm install`). With `--format` given, both arms get a `biome.json` (spaces,
width 100, formatting only) and the whole scratch project formatted first (`formatProject`), so each
starts in the formatter's style, as a project with a formatter does; `on` also formats after each
edit. Only the JS suites (basic, hard).

## Tests

`test/format.test.ts`: detection (Biome before Prettier, config and binary both needed, ruff, black in
a venv, gofmt, rustfmt's edition), settings (off, replace, add, quoting, names), `afterWrite` (the diff
and the record, no change, a failure, a long diff), a whole turn in the OS sandbox (the next edit works
on the formatted text; off by default), and `formatProject` with Biome.
