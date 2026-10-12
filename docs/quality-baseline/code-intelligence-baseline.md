# Java/Python reference evidence (T10)

Measured 12 October 2026, on `second-review-fixes` base `aefac70` plus this T10 patch.
The reference-matching algorithms are unchanged. T10 labels their uncertainty and measures it;
it does not make Java/Python references safe for an automatic rename.

## Frozen language-server sample

Thirty Java symbols in a generated shopkit project and thirty Python symbols were frozen before
capture. Each language has ten feature templates with three retail names each: direct uses,
imports, aliases where supported, homonyms, shadowing, strings/comments, and language-specific
cases. These are synthetic cases, not 30 independent real maintenance tasks or a random sample.

The oracle was captured with **jdtls 1.61.0** (OSGi build `202609031315`; server reports
`1.61.0-SNAPSHOT`) and **pyright 1.1.406**, using Temurin JDK 21.0.12.1 and Node 24.19.0 on Linux
x64. Downloads were checksum-verified. All 66 Java source files compile with `javac`; all 99
Python files parse. A second fresh server/workspace capture returned identical locations for all
60 queries at the time; only one capture is stored, so the repository cannot show that agreement.
Each capture requires project readiness, diagnostics for every source file, a bound
selected declaration, and two identical reference responses. A timeout, import error, source
diagnostic error or unexpected empty reference set prevents writing an oracle.

The scoring unit is **one unique project-relative `path:line`**, excluding the selected declaration.
Garuda returns line hits, so multiple occurrences on a line count once. This can hide a wrong
occurrence on a line that also contains a correct use. Imports returned by the server count as
reference sites. The result limit is 1,000; none of the queries reaches it.

| Language | Queries | True positives | False positives | False negatives | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Java | 30 | 33 | 21 | 3 | 61.1% (33/54) | 91.7% (33/36) |
| Python | 30 | 45 | 18 | 3 | 71.4% (45/63) | 93.8% (45/48) |
| Combined | 60 | 78 | 39 | 6 | 66.7% (78/117) | 92.9% (78/84) |

Precision is TP/(TP+FP); recall is TP/(TP+FN), pooled over sites, not an average of per-query
percentages. Undefined denominators are `null`, never 100%. Per-query locations and mismatches,
source hashes, corpus hash, tool versions and the jdtls core-jar hash are retained in JSON.

The oracle measures agreement with these servers' binding/reference rules. In particular,
pyright can return the original import binding without grouping all downstream uses of a renamed
alias with the original function. Its reference set is not a proof that every affected alias or
dynamic call was found. No caller, impact, Go/Rust, user-plugin, large-repository or runtime
dispatch precision/recall is established by this measurement.

## Supplementary manual edge cases

A separate 16-query corpus (eight per language) uses manually labelled binding sites. Its alias
expectations include downstream alias/reexport uses, which differ from the server's reference
semantics. It is reported separately and is not substituted for the 60-query LSP requirement.

| Language | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| Java | 8 | 7 | 1 | 53.3% (8/15) | 88.9% (8/9) |
| Python | 11 | 5 | 4 | 68.8% (11/16) | 73.3% (11/15) |

## Reproduce and review

Normal validation needs no language-server installation or network:

```sh
corepack pnpm code-intelligence:validate
corepack pnpm check
```

The fixtures are `test/fixtures/code-intelligence-lsp-corpus.json` and
`code-intelligence-lsp-oracle.json`. The published scores are
[`code-intelligence-lsp-results.json`](code-intelligence-lsp-results.json). The manual corpus is
`test/fixtures/code-intelligence-references.json`; its scores are
[`code-intelligence-reference-results.json`](code-intelligence-reference-results.json).

An optional fresh capture requires the pinned servers and a Java 21+ JDK already installed.
`--jdtls` is the install directory containing `plugins/` and `config_*`, not the launcher file;
`--pyright` is the executable path. Use an unused output path:

```sh
corepack pnpm code-intelligence:capture \
  --jdtls /absolute/path/to/jdtls \
  --pyright /absolute/path/to/pyright-langserver \
  --java-home "$JAVA_HOME" \
  --output /tmp/garuda-reference-oracle-new.json
```

This starts local host processes against temporary fixtures, not the user's project, and removes
their workspace afterward. It installs nothing and refuses to overwrite an existing output.
The collector handles Linux x64 and macOS configuration directories; this patch's live capture
was run on Linux only. Compare query locations before replacing the tracked oracle. To refresh
scores after a reviewed implementation/corpus/oracle change:

```sh
GARUDA_LSP_REFERENCE_REPORT=docs/quality-baseline/code-intelligence-lsp-results.json \
  corepack pnpm exec vitest run test/lspReferenceSample.test.ts
GARUDA_REFERENCE_REPORT=docs/quality-baseline/code-intelligence-reference-results.json \
  corepack pnpm exec vitest run test/codeIntelligenceSample.test.ts
```

Run Biome formatting before the final measurement: hashes cover the fixture and source text with
LF line endings, so a CRLF checkout (Windows, `core.autocrlf`) gives the same evidence (Codex review
of 1370184; before, the raw bytes were hashed). Ordinary
tests reject stale evidence, incomplete/empty oracle rows, inconsistent ranges/sites and lower
precision/recall. They also require the complete score report to match, so an improvement needs a
reviewed evidence refresh. The refresh commands generate evidence; they do not approve a lower
baseline. Review every changed false positive/negative and update this record before accepting it.

Fixed floors (Codex review of 1370184): `LSP_FLOORS` in `test/lspReferenceSample.ts` holds the T10
values, Java precision ≥ 33/54 and recall ≥ 33/36, Python precision ≥ 45/63 and recall ≥ 45/48. The
test checks them on every run, also during a refresh, so a refresh cannot lower the bar. Before,
the published JSON was the only bar. A refresh variable (`GARUDA_LSP_REFERENCE_REPORT`,
`GARUDA_REFERENCE_REPORT`) set in CI fails the test: CI compares, it never writes evidence.

## Result labels

Java/Python experts and the index return `approximate: true` on the result envelope. References,
callers and impact preserve it, even with zero hits or a missing symbol. Model output starts with
an explicit warning; chat adds `≈`. Impact risk is labelled heuristic. The warning remains at the
front when large tool output is truncated. TypeScript results do not inherit a Java/Python warning
in mixed projects; absence of the flag makes no claim of perfect accuracy for any language/plugin.

The design originally proposed an `exact` flag on each hit. Result-level metadata is used instead
because empty results and derived impact need the warning too, and a universal `exact: true` claim
would overstate what a language-service lookup proves. No existing plugin must add a mandatory field.

## Patch validation

`pnpm check` passes on Linux: 97 files, 952 ordinary passes, one expected failure and 45
capability/platform skips (998 tests total). This includes typechecking and Biome. CLI ESM/CJS
and site builds pass; the site retains its existing bundle/i18n/404 warnings. The original
`aefac70` matcher returns identical measured sites and scores against the frozen oracle; the
label regressions fail on that base. No accuracy improvement is claimed. macOS execution of
this patch remains for local validation; the normal score tests use the frozen oracle offline.
