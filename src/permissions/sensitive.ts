import { pathMatches } from "./rules.js";

/**
 * Sensitive paths (F20). File tools refuse them unless an allow rule names the file.
 * Paths outside the root (for example ~/.ssh) are already refused by the path guard (F15).
 */
export const SENSITIVE_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  ".envrc",
  "**/.ssh/**",
  "**/.aws/**",
  "**/.gnupg/**",
  "**/.docker/config.json",
  "**/.kube/config",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "id_rsa*",
  "id_ecdsa*",
  "id_ed25519*",
];

/** Paths that write tools may never change, even with approval: git internals. */
export const PROTECTED_WRITE_PATTERNS: readonly string[] = [".git/**"];

export function isSensitive(path: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pathMatches(pattern, path));
}

export function isProtectedFromWrites(path: string): boolean {
  return PROTECTED_WRITE_PATTERNS.some((pattern) => pathMatches(pattern, path));
}
