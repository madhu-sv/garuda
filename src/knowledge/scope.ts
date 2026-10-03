import { posix } from "node:path";

/**
 * Where a line sits in its file, for find_callers and impact_analysis (0.14, Garuda's own review).
 * Before, a call was given to the nearest definition above it, also when the call was outside it
 * (`if __name__ == "__main__": main()` "came from" the function before it, G08).
 */

/** The line (1-based) of the `def`/`class` that holds `line` in a Python file, or undefined (module). */
export function pythonEnclosingLine(lines: readonly string[], line: number): number | undefined {
  const own = lines[line - 1];
  if (own === undefined) return undefined;
  let indent = indentOf(own);
  if (indent === 0) return undefined;
  for (let i = line - 2; i >= 0; i--) {
    const text = lines[i] ?? "";
    if (text.trim() === "" || text.trimStart().startsWith("#")) continue;
    const at = indentOf(text);
    if (at >= indent) continue;
    if (/^\s*(?:async\s+)?def\s|^\s*class\s/.test(text)) return i + 1;
    if (at === 0) return undefined;
    indent = at;
  }
  return undefined;
}

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

/**
 * The brace depth at the start of `line` (1-based) in a C-like file (TS/JS, Java, Go, Rust):
 * 0 means top level. Strings, template literals and comments are skipped; this is a scan, not a
 * parser, but it is enough to tell top-level code from code in a body.
 */
export function braceDepthAt(content: string, line: number): number {
  let depth = 0;
  let current = 1;
  let quote: string | undefined;
  for (let i = 0; i < content.length && current < line; i++) {
    const c = content[i];
    const next = content[i + 1];
    if (c === "\n") {
      current++;
      if (quote === '"' || quote === "'" || quote === "//") quote = undefined;
      continue;
    }
    if (quote === "//") continue;
    if (quote === "/*") {
      if (c === "*" && next === "/") {
        quote = undefined;
        i++;
      }
      continue;
    }
    if (quote !== undefined) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "/" && next === "/") {
      quote = "//";
      i++;
    } else if (c === "/" && next === "*") {
      quote = "/*";
      i++;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

const STRIP_EXT = /\.(?:[cm]?[jt]sx?|py|java|go|rs)$/;

/**
 * True when an import string in `fromPath` names `targetPath` (root-relative paths). Relative
 * imports are resolved; module names (Python `a.b`, Java `com.x.Y`, Go packages) must match the
 * end of the target's path. Before, any import that merely contained the target's base name
 * counted, so every importer of some `index.js` "depended" on src/tools/index.ts.
 */
export function importNames(fromPath: string, imp: string, targetPath: string): boolean {
  const target = targetPath.replace(STRIP_EXT, "");
  const fromDir = posix.dirname(fromPath);
  if (imp.startsWith(".")) {
    let resolved: string;
    if (fromPath.endsWith(".py") && !imp.startsWith("./") && !imp.startsWith("../")) {
      // Python: one dot is this package, each more dot one folder up.
      const dots = imp.length - imp.replace(/^\.+/, "").length;
      let base = fromDir;
      for (let i = 1; i < dots; i++) base = posix.dirname(base);
      resolved = posix.join(base, imp.slice(dots).replaceAll(".", "/"));
    } else {
      resolved = posix.normalize(posix.join(fromDir, imp)).replace(STRIP_EXT, "");
    }
    return (
      resolved === target || `${resolved}/index` === target || `${resolved}/__init__` === target
    );
  }
  const module = /[/@]/.test(imp) ? imp : imp.replaceAll(".", "/").replaceAll("::", "/");
  if (target === module || target.endsWith(`/${module}`)) return true;
  // Go imports a package (a folder).
  const folder = posix.dirname(targetPath);
  return targetPath.endsWith(".go") && (folder === module || module.endsWith(`/${folder}`));
}
