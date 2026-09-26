/**
 * A small frontmatter reader for skills and agents (0.5): plain `key: value` lines, quoted values,
 * block values (`key: >` or `key: |` with indented lines) and lists (`key: [a, b]` or indented
 * `- a` lines), which become "a, b". Nested maps (for example `metadata:` or `hooks:`) are skipped:
 * Garuda does not use them, so no YAML library is needed.
 */
export function parseFrontmatterBlock(text: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (match === null) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = (match[1] ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i] ?? "");
    if (kv?.[1] === undefined) continue;
    const key = kv[1].toLowerCase();
    const value = (kv[2] ?? "").trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-" || value === "") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1] ?? "")) {
        block.push((lines[++i] ?? "").trim());
      }
      const items = block.filter((l) => l !== "");
      if (items.length > 0 && items.every((l) => /^-\s/.test(l))) {
        meta[key] = items.map((l) => unquote(l.slice(1).trim())).join(", ");
        continue;
      }
      // An indented map under the key: not a text value.
      if (items.some((l) => /^-\s|^[\w-]+\s*:/.test(l))) continue;
      const joined = value.startsWith("|") ? block.join("\n") : block.join(" ");
      if (joined.trim() !== "") meta[key] = joined.trim();
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => unquote(v.trim()))
        .filter((v) => v !== "")
        .join(", ");
      continue;
    }
    if (value.startsWith("{")) continue;
    meta[key] = unquote(value);
  }
  return { meta, body: text.slice(match[0].length) };
}

function unquote(value: string): string {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}
