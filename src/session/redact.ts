/**
 * Secret redaction for session files (N6). The model may still see a secret
 * (for example in a tool result), but Garuda never writes it to disk.
 */

export const REDACTED = "[REDACTED]";

const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** `password = "hunter22"` → `password = "[REDACTED]"`. The name stays, so the text still makes sense. */
const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s"'`,;]{8,})/gi;

/**
 * Opaque values from the provider (0.6: Claude's web search). They must go back to the API
 * unchanged, and they are ciphertext, so a pattern match in them is chance, not a secret.
 */
/** Opaque provider values that must stay byte for byte: encrypted search results, thinking signatures. */
const OPAQUE_KEYS = new Set(["encrypted_content", "encrypted_index", "signature"]);

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

export class Redactor {
  private readonly literals: string[];

  /** `env`: variables whose names look secret have their values removed wherever they appear. */
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.literals = Object.entries(env)
      .filter(([name, value]) => SECRET_ENV_NAME.test(name) && (value?.length ?? 0) >= 8)
      .map(([, value]) => value as string)
      .sort((a, b) => b.length - a.length);
  }

  text(input: string): string {
    let out = input;
    for (const literal of this.literals) out = out.split(literal).join(REDACTED);
    for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
    return out.replace(ASSIGNMENT, (_all, name: string, sep: string) => `${name}${sep}${REDACTED}`);
  }

  /** A copy of `value` with every string redacted. */
  value<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.walk(item));
    if (value !== null && typeof value === "object") {
      // A redacted_thinking block's `data` is encrypted too (0.9); other `data` keys are redacted.
      const redactedThinking = (value as { type?: unknown }).type === "redacted_thinking";
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          (OPAQUE_KEYS.has(k) || (redactedThinking && k === "data")) && typeof v === "string"
            ? v
            : this.walk(v),
        ]),
      );
    }
    return value;
  }
}
