import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ENV_ALLOWLIST } from "../permissions/engine.js";
import type { ExecPolicy, Executor } from "../sandbox/types.js";

/**
 * The staging copy for staged commands (0.17, review T5; docs/lld/bounded-changes.md). A command
 * in staged mode runs in this copy, never in the project; only an approved apply copies files back.
 *
 * - Linux: `cp -a --reflink=auto`. With a file system that has no reflink, it is a plain copy.
 * - macOS: `cp -a -c` (clonefile on APFS). On another file system, a plain copy.
 *
 * A plain copy over `maxPlainBytes` (2 GB) is refused: the session does not start. Garuda never
 * runs staged commands in direct mode instead (second review: no silent fallback).
 *
 * The copy lives in ~/.garuda/staging/<root hash>-<pid>-<random>. Sandbox commands cannot write
 * ~/.garuda, except this copy when the command is staged. Copies of processes that ended (a crash)
 * are removed at the next start for the same project.
 */

/** A plain copy (no clone, no reflink) larger than this stops the session start. */
export const MAX_PLAIN_COPY_BYTES = 2 * 1024 ** 3;
const COPY_TIMEOUT_MS = 600_000;

export class StagingError extends Error {
  override readonly name = "StagingError";
}

export type CopyMethod = "clone" | "reflink" | "plain";

export interface StagingOptions {
  /** Runs cp, du and rm on the host (N8: only src/sandbox starts processes). */
  executor: Executor;
  home?: string;
  platform?: NodeJS.Platform;
  maxPlainBytes?: number;
  /** For tests: whether a process id still runs. */
  alive?: (pid: number) => boolean;
}

export class StagingCopy {
  private constructor(
    /** The project. */
    readonly root: string,
    /** The copy: the command's working root on macOS, bound at the project's path on Linux. */
    readonly path: string,
    readonly method: CopyMethod,
  ) {}

  /** Make the copy, or throw StagingError with the reason. */
  static async create(root: string, options: StagingOptions): Promise<StagingCopy> {
    const home = options.home ?? homedir();
    const platform = options.platform ?? process.platform;
    const base = join(home, ".garuda", "staging");
    const id = rootId(root);
    await mkdir(base, { recursive: true, mode: 0o700 });
    await removeStale(base, id, options.alive ?? isAlive);
    const path = join(base, `${id}-${process.pid}-${randomBytes(4).toString("hex")}`);
    const run = (command: string) => host(options.executor, root, command);

    // Probe the fast methods on one small file, so a plain copy is known before it starts.
    const probe = await run(
      `f=$(mktemp ${q(join(base, ".probe-XXXXXX"))}) && cp ${platform === "darwin" ? "-c" : "--reflink=always"} "$f" "$f.copy"; s=$?; rm -f "$f" "$f.copy"; exit $s`,
    );
    const method: CopyMethod =
      probe.exitCode === 0 ? (platform === "darwin" ? "clone" : "reflink") : "plain";
    if (method === "plain") {
      const max = options.maxPlainBytes ?? MAX_PLAIN_COPY_BYTES;
      const du = await run(`du -sk -- ${q(root)}`);
      const kb = Number.parseInt(du.stdout.text.trim().split(/\s/)[0] ?? "", 10);
      if (du.exitCode !== 0 || !Number.isFinite(kb)) {
        throw new StagingError(
          `Garuda could not measure the project for the staging copy: ${why(du)}`,
        );
      }
      if (kb * 1024 > max) {
        throw new StagingError(
          `The project is ${gb(kb * 1024)} GB, and this file system cannot clone it: a plain staging copy is limited to ${gb(max)} GB. Staged commands are off for this session; use "commands": { "mode": "direct" }, or move the project to a file system with clones (APFS, Btrfs, XFS).`,
        );
      }
    }
    const flags =
      method === "clone" ? "-a -c" : method === "reflink" ? "-a --reflink=always" : "-a";
    // `src/.` copies the contents, also dot files, into a new folder.
    const copy = await run(
      `mkdir -m 700 -- ${q(path)} && cp ${flags} -- ${q(`${root}/.`)} ${q(path)}`,
    );
    if (copy.exitCode !== 0) {
      await rm(path, { recursive: true, force: true }).catch(() => {});
      throw new StagingError(`Garuda could not make the staging copy: ${why(copy)}`);
    }
    return new StagingCopy(root, path, method);
  }

  /** Remove the copy (at the session end). */
  async remove(): Promise<void> {
    await rm(this.path, { recursive: true, force: true });
  }
}

/** ~/.garuda/staging/<first 16 hex of sha256(root)>-… */
export function rootId(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

async function removeStale(base: string, id: string, alive: (pid: number) => boolean) {
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return;
  }
  for (const name of names) {
    const match = new RegExp(`^${id}-(\\d+)-[0-9a-f]+$`).exec(name);
    if (match === null || alive(Number(match[1]))) continue;
    await rm(join(base, name), { recursive: true, force: true }).catch(() => {});
  }
}

function isAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function host(executor: Executor, root: string, command: string) {
  const policy: ExecPolicy = {
    root,
    sandbox: false,
    writePaths: [],
    denyWritePaths: [],
    denyReadPaths: [],
    network: false,
    envAllowlist: [...DEFAULT_ENV_ALLOWLIST],
    timeoutMs: COPY_TIMEOUT_MS,
    maxOutputBytes: 100_000,
  };
  return executor.run(command, policy);
}

function why(result: { stderr: { text: string }; stdout: { text: string }; timedOut: boolean }) {
  if (result.timedOut) return `it took longer than ${COPY_TIMEOUT_MS / 1000} s.`;
  return (
    (result.stderr.text || result.stdout.text).trim().split("\n").slice(-3).join(" ") || "no output"
  );
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

/** One shell word. */
function q(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}
