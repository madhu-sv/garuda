import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Escaped processes on macOS (0.17, IPI-04; docs/lld/sandbox.md). Seatbelt has no process
 * namespace: a process can leave the command's process group (setsid, setpgid, posix_spawn with
 * POSIX_SPAWN_SETSID or POSIX_SPAWN_SETPGROUP) and outlive the command. It cannot leave its
 * Seatbelt profile. So each sandboxed command gets two marker files in its profile (reads of A
 * denied, reads of B allowed), and after the command the helper native/bin/garuda-reap kills every
 * process of the user with that profile (A denied, B allowed). See native/garuda-reap.c.
 *
 * Each executor keeps its markers in a new folder in the temp folder. The tracker's own rule
 * denies writes there (the last matching rule wins), so a command cannot delete its markers to
 * hide, although the rest of the temp folder is writable. The helper refuses to run when a marker
 * is missing.
 */

const HELPER_TIMEOUT_MS = 10_000;

/** One command's markers: the profile rules, and the cleanup after the command. */
export interface Tracker {
  /** Seatbelt rules to append to the profile (the last matching rule wins). */
  readonly rules: string[];
  /** Kill the processes with these markers that still run, then remove the markers. */
  reap(): Promise<number>;
  /** The same, synchronous (process exit, shutdown). */
  reapSync(): number;
  /** Remove the markers without a scan (the command never started). */
  dispose(): void;
}

export class ReapError extends Error {
  override readonly name = "ReapError";
}

export class Reaper {
  private folder: string | undefined;

  constructor(
    readonly helper: string,
    private readonly parent: string = tmpdir(),
  ) {}

  /** The markers folder, made at the first command. Seatbelt matches real paths (/private/var). */
  private dir(): string {
    this.folder ??= realpathSync(mkdtempSync(join(this.parent, "garuda-markers-")));
    return this.folder;
  }

  /** Remove the markers folder (at shutdown). */
  close(): void {
    if (this.folder !== undefined) rmSync(this.folder, { recursive: true, force: true });
    this.folder = undefined;
  }

  /** New markers for one command. */
  track(): Tracker {
    const dir = this.dir();
    const id = randomBytes(8).toString("hex");
    const a = join(dir, `${id}-a`);
    const b = join(dir, `${id}-b`);
    // The kernel's check needs real files: a missing path reads as denied for every process.
    writeFileSync(a, "", { mode: 0o600 });
    writeFileSync(b, "", { mode: 0o600 });
    const remove = () => {
      rmSync(a, { force: true });
      rmSync(b, { force: true });
    };
    const helper = this.helper;
    return {
      rules: [
        `(deny file-read* (literal ${quote(a)}))`,
        `(allow file-read* (literal ${quote(b)}))`,
        `(deny file-write* (subpath ${quote(dir)}))`,
      ],
      reap: () =>
        new Promise<number>((resolve, reject) => {
          execFile(
            helper,
            [a, b],
            { timeout: HELPER_TIMEOUT_MS, encoding: "utf8" },
            (error, stdout, stderr) => {
              remove();
              if (error) reject(new ReapError(why(error.message, stderr)));
              else resolve(killed(stdout));
            },
          );
        }),
      reapSync: () => {
        const r = spawnSync(helper, [a, b], { timeout: HELPER_TIMEOUT_MS, encoding: "utf8" });
        remove();
        if (r.status !== 0) throw new ReapError(why(r.error?.message ?? "", r.stderr ?? ""));
        return killed(r.stdout ?? "");
      },
      dispose: remove,
    };
  }
}

/**
 * The helper next to this package: native/bin/garuda-reap, searched upward from this module
 * (src/sandbox in a checkout, dist/… in the package). Undefined when it is missing, also in the
 * standalone binary.
 */
export function locateHelper(): string | undefined {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "native", "bin", "garuda-reap");
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

function killed(stdout: string): number {
  const match = /killed (\d+)/.exec(stdout);
  return match === null ? 0 : Number(match[1]);
}

function why(message: string, stderr: string): string {
  return `garuda-reap failed: ${(stderr.trim() || message).split("\n")[0]}`;
}

/** A Seatbelt (Scheme) string literal. */
function quote(path: string): string {
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
