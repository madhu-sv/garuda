import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * Stored provider keys (0.16, see docs/lld/setup.md): `~/.garuda/credentials`, JSON from key name
 * (the provider's `apiKeyEnv`) to key. Only `garuda setup` writes it. An environment variable with
 * the same name wins. Commands in the OS sandbox cannot read the file (DENY_READ_IN_HOME).
 *
 * Garuda reads the file only when it is a regular file (not a symbolic link), owned by this user,
 * with no group or other permission bits, as SSH does with its keys. Else it ignores the file with
 * a warning. A warning never holds the file's content.
 */

export const CREDENTIALS_FILE = join(".garuda", "credentials");

/** The largest credentials file that Garuda reads. A few keys need far less. */
export const CREDENTIALS_MAX_BYTES = 64 * 1024;

export const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const fileSchema = z.record(z.string().regex(KEY_NAME), z.string().min(1).max(4_096));

export interface StoredKeys {
  /** Key name → key. Empty when the file is missing or ignored. */
  keys: Record<string, string>;
  /** Why the file was ignored, and how to fix it. Never holds a key. */
  warning?: string;
}

export function credentialsPath(home: string = homedir()): string {
  return join(home, CREDENTIALS_FILE);
}

export async function readCredentials(home: string = homedir()): Promise<StoredKeys> {
  const file = credentialsPath(home);
  const ignored = (why: string): StoredKeys => ({
    keys: {},
    warning: `${file} ${why} Garuda ignores it.`,
  });
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // O_NOFOLLOW: a symbolic link fails here (ELOOP), so the checks below see the file itself.
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { keys: {} };
    if (code === "ELOOP") return ignored("is a symbolic link.");
    return ignored(`cannot be read (${code ?? "error"}).`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return ignored("is not a regular file.");
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) return ignored("is not owned by you.");
    if ((info.mode & 0o077) !== 0) {
      return ignored(`can be read by other users. Run: chmod 600 ${file}.`);
    }
    if (info.size > CREDENTIALS_MAX_BYTES) return ignored("is too large.");
    const text = await handle.readFile("utf8");
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      // The parser's message can quote the text, so it is not shown.
      return ignored("is not valid JSON.");
    }
    const parsed = fileSchema.safeParse(data);
    if (!parsed.success) {
      return ignored(
        'is not valid: it must be a JSON object of key names to keys, for example { "ANTHROPIC_API_KEY": "…" }.',
      );
    }
    return { keys: parsed.data };
  } finally {
    await handle.close();
  }
}

/**
 * Write the stored keys (only `garuda setup` calls this). The file is replaced in one step: a
 * private temporary file (0600 from the start) in the same folder, then a rename. A rename replaces
 * a link itself, never its target. An empty set removes the file. A new ~/.garuda is 0700.
 */
export async function writeCredentials(
  keys: Record<string, string>,
  home: string = homedir(),
): Promise<void> {
  const file = credentialsPath(home);
  if (Object.keys(keys).length === 0) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = join(dirname(file), `.credentials.garuda-${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temp, `${JSON.stringify(keys, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await chmod(temp, 0o600);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** A key for the screen: the start and the last four characters, never the whole key. */
export function maskKey(key: string): string {
  // A short key shows less: at most a quarter of it, so the rest stays long enough to guess at.
  if (key.length < 16) return "…";
  if (key.length < 32) return `…${key.slice(-4)}`;
  const start = key.match(/^[A-Za-z]+-(?:[A-Za-z]+-)?/)?.[0] ?? key.slice(0, 3);
  return `${start.slice(0, 8)}…${key.slice(-4)}`;
}
