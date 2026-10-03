// Copy the repository's Markdown docs into the site, so the docs have one source: docs/ and
// README.md. Each file gets Starlight front matter (its first "# " heading becomes the title), and
// relative links are rewritten: to the site page when the target is a synced doc, otherwise to the
// file on GitHub. The output folders are generated (see site/.gitignore); edit the sources instead.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(site, "..");
const BASE = "/garuda";
const GITHUB = "https://github.com/madhu-sv/garuda";
const OUT = join(site, "src/content/docs/docs");

/** Repository path (posix) → site path below /docs/, for every synced file. */
const pages = new Map([["README.md", "guide"]]);
for (const file of walk(join(repo, "docs"))) {
  const path = posix.normalize(relative(repo, file).split("\\").join("/"));
  if (!path.endsWith(".md")) continue;
  const inner = path.slice("docs/".length, -".md".length).replace(/(^|\/)README$/, "$1index");
  pages.set(path, `design/${inner.replace(/^quality-baseline/, "quality")}`);
}

rmSync(join(OUT, "design"), { recursive: true, force: true });
rmSync(join(OUT, "guide.md"), { force: true });

for (const [source, target] of pages) {
  const text = readFileSync(join(repo, source), "utf8");
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith("# "));
  // Titles are plain text in the sidebar and the page header: no Markdown code marks.
  const title = (at >= 0 ? lines[at].slice(2).trim() : posix.basename(target)).replaceAll("`", "");
  if (at >= 0) lines.splice(at, 1);
  // README.md starts with the CI badge; the site shows its own header.
  const body = mermaidBlocks(rewriteLinks(lines.join("\n"), source))
    .replace(/^\[!\[CI\]\([^)]*\)\]\([^)]*\)\n+/m, "")
    .trimStart();
  const front = [
    "---",
    `title: ${JSON.stringify(source === "README.md" ? "User guide" : title)}`,
    `editUrl: ${JSON.stringify(`${GITHUB}/edit/main/${source}`)}`,
    "---",
    "",
    `> This page is generated from [\`${source}\`](${GITHUB}/blob/main/${source}) in the repository.`,
    "",
    "",
  ].join("\n");
  const file = join(OUT, `${target}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${front}${body}`);
}
console.log(`sync-docs: ${pages.size} pages`);

/**
 * A ```mermaid block becomes <pre class="mermaid"> (raw HTML), so the code highlighter leaves it
 * alone and the browser draws it (src/components/MarkdownContent.astro). Without JavaScript the
 * reader still sees the diagram's source.
 */
function mermaidBlocks(text) {
  const html = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return text.replace(
    /^```mermaid\n([\s\S]*?)^```[ \t]*$/gm,
    (_all, source) => `<pre class="mermaid">\n${html(source.trimEnd())}\n</pre>`,
  );
}

/** Rewrite relative Markdown links `](path)` of one source file. */
function rewriteLinks(text, source) {
  let fence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) fence = !fence;
      if (fence) return line;
      return line.replace(/\]\(([^)\s]+)\)/g, (all, href) => {
        if (/^(https?:|mailto:|#|\/)/.test(href)) return all;
        const [path, anchor] = href.split("#");
        const target = posix.normalize(posix.join(posix.dirname(source), path));
        const page = pages.get(target);
        if (page !== undefined) {
          const url = `${BASE}/docs/${page.replace(/(^|\/)index$/, "$1")}`.replace(/\/?$/, "/");
          return `](${url}${anchor === undefined ? "" : `#${anchor}`})`;
        }
        const kind = isFolder(target) ? "tree" : "blob";
        return `](${GITHUB}/${kind}/main/${target}${anchor === undefined ? "" : `#${anchor}`})`;
      });
    })
    .join("\n");
}

function isFolder(path) {
  try {
    return statSync(join(repo, path)).isDirectory();
  } catch {
    return false;
  }
}

function* walk(folder) {
  for (const name of readdirSync(folder)) {
    const full = join(folder, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}
