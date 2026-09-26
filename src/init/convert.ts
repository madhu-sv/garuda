import { SERVER_NAME } from "../mcp/config.js";

/**
 * Small conversions from other agents' formats to Garuda's (0.5). Pure functions: the readers in
 * sources.ts use them, and the tests check them one by one.
 */

/** Words in an env name that mean a secret: its value is never copied. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|CRED|AUTH/i;

/** A Garuda server name from another agent's name: lower case, [a-z0-9_], at most 32. */
export function serverName(name: string): string | undefined {
  const out = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+/, "")
    .slice(0, 32);
  return SERVER_NAME.test(out) ? out : undefined;
}

/** A Garuda command name part: lower case, [a-z0-9-_]. */
export function commandPart(name: string): string | undefined {
  const out = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z0-9][a-z0-9_-]*$/.test(out) ? out : undefined;
}

/**
 * Env values for mcp.json. `${VAR}` stays. OpenCode's `{env:VAR}` becomes `${VAR}`. A literal value
 * under a secret-looking name is not copied: it becomes `${NAME}`, with a note.
 */
export function convertEnv(
  env: Record<string, unknown> | undefined,
  source: string,
  notes: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      notes.push(`env "${key}" is not a valid name; left out`);
      continue;
    }
    const value = String(raw ?? "").replace(
      /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_, name: string) => `\${${name}}`,
    );
    if (value.includes("${") || value === "") {
      out[key] = value;
    } else if (SECRET_NAME.test(key)) {
      out[key] = `\${${key}}`;
      notes.push(
        `${key} held a value in ${source}; Garuda does not copy it: set ${key} in your environment`,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * A command file for Garuda from a Markdown command of another agent (Claude Code, OpenCode,
 * Codex). Garuda keeps `description` and `argument-hint`; other keys are left out with a note.
 * Placeholders `$ARGUMENTS` and `$1`…`$9` are the same.
 */
export function commandFromMarkdown(text: string, notes: string[]): string {
  let body = text;
  const meta: Record<string, string> = {};
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (fm !== null) {
    body = text.slice(fm[0].length);
    for (const line of (fm[1] ?? "").split(/\r?\n/)) {
      const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
      if (m === null) continue;
      const key = (m[1] as string).toLowerCase();
      const value = (m[2] as string).trim().replace(/^["']|["']$/g, "");
      if (key === "description" || key === "argument-hint") meta[key] = value;
      else notes.push(`"${key}" in the front matter is left out (Garuda has no such option)`);
    }
  }
  return withMeta(meta, body, notes);
}

/** A command file for Garuda from a Gemini CLI / Tabnine TOML command (`prompt`, `description`). */
export function commandFromToml(
  data: Record<string, unknown>,
  notes: string[],
): string | undefined {
  if (typeof data.prompt !== "string" || data.prompt.trim() === "") return undefined;
  const meta: Record<string, string> = {};
  if (typeof data.description === "string") meta.description = data.description;
  return withMeta(meta, data.prompt.replaceAll("{{args}}", "$ARGUMENTS"), notes);
}

function withMeta(meta: Record<string, string>, body: string, notes: string[]): string {
  if (/!`[^`]*`|!\{[^}]*\}/.test(body)) {
    notes.push("it runs shell commands in the prompt (!`…`); Garuda sends that text as it is");
  }
  if (/(^|\s)@\{?[\w./-]+/.test(body)) {
    notes.push("it includes files with @…; Garuda sends that text as it is");
  }
  const keys = Object.entries(meta).filter(([, v]) => v !== "");
  const head =
    keys.length === 0
      ? ""
      : `---\n${keys.map(([k, v]) => `${k}: ${v.replace(/\n/g, " ")}`).join("\n")}\n---\n`;
  return `${head}${body.trim()}\n`;
}

/**
 * Claude Code permission rules → Garuda rules. `Bash(npm test:*)` and `Bash(npm test *)` become
 * `bash(npm test*)`; `Read(x)` → `read_file(x)`; `Edit(x)`/`Write(x)` → `edit_file(x)` and
 * `write_file(x)`; `WebFetch(domain:h)` → `web_fetch(h)`; `mcp__s__t` stays. Others: undefined.
 */
export function claudeRule(text: string): string[] | undefined {
  const t = text.trim();
  if (/^mcp__[\w-]+(__[\w*-]+)?$/.test(t)) return [t];
  const m = /^([A-Za-z]+)(?:\((.*)\))?$/.exec(t);
  if (m === null) return undefined;
  const tool = m[1] as string;
  const arg = m[2]?.trim();
  const path = (p: string | undefined) =>
    p === undefined || p === "" ? "" : `(${p.replace(/^\.\//, "")})`;
  switch (tool) {
    case "Bash": {
      if (arg === undefined || arg === "") return ["bash"];
      return [`bash(${arg.replace(/:\*$/, "*").replace(/ \*$/, "*")})`];
    }
    case "Read":
      return [`read_file${path(arg)}`];
    case "Edit":
    case "Write":
    case "MultiEdit":
      return [`edit_file${path(arg)}`, `write_file${path(arg)}`];
    case "WebFetch": {
      const host = arg?.startsWith("domain:") ? arg.slice(7) : undefined;
      return host === undefined
        ? arg === undefined
          ? ["web_fetch"]
          : undefined
        : [`web_fetch(${host})`];
    }
    default:
      return undefined;
  }
}

/** OpenCode `permission` → Garuda rules. "ask" is Garuda's default, so it adds nothing. */
export function openCodeRules(permission: unknown): { list: "allow" | "deny"; rule: string }[] {
  if (permission === null || typeof permission !== "object") return [];
  const out: { list: "allow" | "deny"; rule: string }[] = [];
  const tools: Record<string, string[]> = {
    bash: ["bash"],
    edit: ["edit_file", "write_file"],
    webfetch: ["web_fetch"],
    read: ["read_file"],
  };
  for (const [key, value] of Object.entries(permission as Record<string, unknown>)) {
    const targets = tools[key];
    if (targets === undefined) continue;
    const add = (action: unknown, pattern?: string) => {
      if (action !== "allow" && action !== "deny") return;
      for (const tool of targets) {
        out.push({
          list: action,
          rule: pattern === undefined || pattern === "*" ? tool : `${tool}(${pattern})`,
        });
      }
    };
    if (typeof value === "string") add(value);
    else if (value !== null && typeof value === "object") {
      for (const [pattern, action] of Object.entries(value as Record<string, unknown>)) {
        add(action, key === "bash" ? pattern.replace(/ \*$/, "*") : pattern);
      }
    }
  }
  return out;
}

/** JSON with comments and trailing commas (opencode.jsonc, settings files). */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) break;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
