import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

/**
 * Formatters after edits (0.10). Garuda finds the project's formatter from its config files and
 * a binary that is already there (in the project, or on PATH); it never installs one. The user can
 * add, change or turn off formatters in settings. Detection only reads files: nothing runs here.
 * The runtime runs the command in the OS sandbox after edit_file or write_file.
 */

export interface Formatter {
  name: string;
  /** File extensions without the dot, lower case. */
  extensions: string[];
  /** argv; "$FILE" is the absolute path of the file. */
  command: string[];
}

/** A formatter setting: a new or changed formatter, or false to turn a detected one off. */
export type FormatterSetting = false | { extensions: string[]; command: string[] };

const JS_EXTENSIONS = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"];

/**
 * The formatters for a project, in order of priority (the first that takes an extension wins).
 * `path` is the PATH to search for binaries that are not in the project.
 */
export function detectFormatters(
  root: string,
  path: string | undefined,
  settings: Readonly<Record<string, FormatterSetting>> = {},
): Formatter[] {
  const found: Formatter[] = [];
  const onPath = (name: string) => findOnPath(name, path);
  const local = (name: string) => {
    const file = join(root, "node_modules", ".bin", name);
    return isFile(file) ? file : undefined;
  };
  const venv = (name: string) =>
    [join(root, ".venv", "bin", name), join(root, "venv", "bin", name)].find(isFile);

  // Biome, then Prettier: a JS project with both formats with Biome.
  const biome = local("biome");
  if (biome !== undefined && ["biome.json", "biome.jsonc"].some((f) => isFile(join(root, f)))) {
    found.push({
      name: "biome",
      extensions: [...JS_EXTENSIONS, "json", "jsonc", "css"],
      command: [biome, "format", "--write", "$FILE"],
    });
  }
  const prettier = local("prettier");
  if (prettier !== undefined && hasPrettierConfig(root)) {
    found.push({
      name: "prettier",
      extensions: [
        ...JS_EXTENSIONS,
        "json",
        "css",
        "scss",
        "less",
        "md",
        "yaml",
        "yml",
        "html",
        "vue",
      ],
      command: [prettier, "--write", "$FILE"],
    });
  }
  const pyproject = readText(join(root, "pyproject.toml"));
  const ruff = venv("ruff") ?? onPath("ruff");
  if (
    ruff !== undefined &&
    (pyproject.includes("[tool.ruff") ||
      ["ruff.toml", ".ruff.toml"].some((f) => isFile(join(root, f))))
  ) {
    found.push({ name: "ruff", extensions: ["py", "pyi"], command: [ruff, "format", "$FILE"] });
  }
  const black = venv("black") ?? onPath("black");
  if (black !== undefined && pyproject.includes("[tool.black")) {
    found.push({ name: "black", extensions: ["py", "pyi"], command: [black, "-q", "$FILE"] });
  }
  const gofmt = onPath("gofmt");
  if (gofmt !== undefined && isFile(join(root, "go.mod"))) {
    found.push({ name: "gofmt", extensions: ["go"], command: [gofmt, "-w", "$FILE"] });
  }
  const rustfmt = onPath("rustfmt");
  const cargo = readText(join(root, "Cargo.toml"));
  if (rustfmt !== undefined && cargo !== "") {
    const edition = /^\s*edition\s*=\s*"(\d{4})"/m.exec(cargo)?.[1] ?? "2021";
    found.push({
      name: "rustfmt",
      extensions: ["rs"],
      command: [rustfmt, "--edition", edition, "$FILE"],
    });
  }

  // Settings: a name with false turns it off; a name with a command adds or replaces it (first).
  const out = found.filter((f) => settings[f.name] === undefined);
  const custom: Formatter[] = [];
  for (const [name, setting] of Object.entries(settings)) {
    if (setting === false) continue;
    custom.push({
      name,
      extensions: setting.extensions.map((e) => e.replace(/^\./, "").toLowerCase()),
      command: setting.command,
    });
  }
  return [...custom, ...out];
}

/** The formatter for a file, or undefined. */
export function formatterFor(
  formatters: readonly Formatter[],
  file: string,
): Formatter | undefined {
  const ext = extname(file).slice(1).toLowerCase();
  if (ext === "") return undefined;
  return formatters.find((f) => f.extensions.includes(ext));
}

/** The shell command for one file: each word quoted, "$FILE" replaced. */
export function formatCommand(formatter: Formatter, file: string): string {
  return formatter.command.map((word) => shellWord(word === "$FILE" ? file : word)).join(" ");
}

function shellWord(text: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

function hasPrettierConfig(root: string): boolean {
  const files = [
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yaml",
    ".prettierrc.yml",
    ".prettierrc.js",
    ".prettierrc.cjs",
    ".prettierrc.mjs",
    ".prettierrc.toml",
    "prettier.config.js",
    "prettier.config.cjs",
    "prettier.config.mjs",
  ];
  if (files.some((f) => isFile(join(root, f)))) return true;
  try {
    const pkg = JSON.parse(readText(join(root, "package.json")) || "{}") as { prettier?: unknown };
    return pkg.prettier !== undefined;
  } catch {
    return false;
  }
}

function findOnPath(name: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") continue;
    const file = join(dir, name);
    if (isFile(file)) return file;
  }
  return undefined;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function readText(file: string): string {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}
