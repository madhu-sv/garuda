/**
 * Transient model errors (0.3). A response stream can break after it started: the connection
 * closes ("terminated" in undici), the server resets it, or the provider reports an overload in
 * the stream. The SDKs retry only before the stream starts, so the loop retries these itself.
 *
 * This module looks at plain properties (name, code, status, message, cause), so it needs no
 * provider SDK (N1). Errors that a retry cannot fix are not transient: a bad request, a missing
 * key, a refused connection to a server that is not running, or a user abort.
 */

const TRANSIENT_NAMES = new Set([
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "InternalServerError",
]);

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

const TRANSIENT_STATUS = new Set([500, 502, 503, 504, 529]);

const TRANSIENT_TYPES = new Set(["overloaded_error", "api_error"]);

const TRANSIENT_MESSAGE =
  /^terminated$|socket hang up|other side closed|premature close|connection (?:error|reset|closed)|stream ended without a response|overloaded/i;

/** True when a new attempt of the same request can succeed. */
export function isTransientModelError(error: unknown): boolean {
  return check(error, 0);
}

function check(error: unknown, depth: number): boolean {
  if (depth > 4 || error === null || typeof error !== "object") return false;
  const e = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    message?: unknown;
    error?: { type?: unknown; error?: { type?: unknown } };
    cause?: unknown;
    errors?: unknown;
  };
  // A user abort is never retried.
  if (e.name === "AbortError") return false;
  if (typeof e.status === "number" && e.status >= 400 && e.status < 500) return false;
  if (typeof e.name === "string" && TRANSIENT_NAMES.has(e.name)) return true;
  if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
  if (typeof e.status === "number" && TRANSIENT_STATUS.has(e.status)) return true;
  // Anthropic reports errors in the stream as { error: { type } } (sometimes nested once more).
  const type = e.error?.type ?? e.error?.error?.type;
  if (typeof type === "string" && TRANSIENT_TYPES.has(type)) return true;
  if (typeof e.message === "string" && TRANSIENT_MESSAGE.test(e.message)) return true;
  if (e.cause !== undefined && check(e.cause, depth + 1)) return true;
  // Node tries IPv4 and IPv6 and wraps the errors of both in an AggregateError.
  return Array.isArray(e.errors) && e.errors.some((inner) => check(inner, depth + 1));
}

/** A short reason for the user, for example "terminated" or "ECONNRESET". */
export function errorReason(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown; cause?: { code?: unknown } };
  const code = typeof e?.code === "string" ? e.code : e?.cause?.code;
  if (typeof code === "string") return code;
  const message = typeof e?.message === "string" ? e.message : String(error);
  return message.length <= 80 ? message : `${message.slice(0, 79)}…`;
}
