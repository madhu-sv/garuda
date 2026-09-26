import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ENV_ALLOWLIST } from "../permissions/engine.js";
import type { ExecPolicy, Executor } from "../sandbox/types.js";

/**
 * The file side of undo (0.4): snapshots of the project in a git store of Garuda's own, one per
 * project folder, in ~/.garuda/snapshots/<hash of the root>. It never touches the project's own
 * .git: the store has its own git folder and index, and the project is only its work tree.
 *
 * - take():   `git add -A` + `git write-tree` → a tree id. .gitignore rules apply, so ignored
 *             folders (node_modules, build output) are not in the snapshots.
 * - changes(): the files that differ between two trees.
 * - restore(): `git read-tree -m -u <from> <to>`: the work tree goes from one snapshot to another,
 *             with new, changed and deleted files. It refuses when a file changed in between.
 *
 * git runs through the Executor (N8), outside the sandbox (the store is outside the project), with
 * no system or global git config, no hooks and no fsmonitor: only Garuda's own settings apply.
 * Sandbox commands cannot write ~/.garuda, so they cannot change the undo history.
 */

/** Paths that are never in a snapshot: Garuda's own records and caches, and the project's .git. */
export const SNAPSHOT_EXCLUDES = [".git", ".garuda/sessions/", ".garuda/index/", ".garuda/evals/"];
/** A project with more files than this gets no snapshots (the first `git add` would be too slow). */
export const MAX_SNAPSHOT_FILES = 50_000;
/** A snapshot that takes longer than this turns undo off for the session. */
export const SLOW_SNAPSHOT_MS = 10_000;
const GIT_TIMEOUT_MS = 120_000;
/** Snapshots between two `git gc --auto` runs. */
const GC_EVERY = 20;

export type FileChange = { status: "added" | "modified" | "deleted"; path: string };

/** A change with its line counts (0.6, /diff). Binary files have no counts. */
export type FileStat = FileChange & { added?: number; removed?: number };

export class SnapshotError extends Error {}

export class SnapshotStore {
  private ready: Promise<void> | undefined;
  private taken = 0;

  constructor(
    private readonly root: string,
    private readonly executor: Executor,
    readonly dir: string = storeDir(root),
    private readonly maxFiles: number = MAX_SNAPSHOT_FILES,
  ) {}

  /** Take a snapshot of the work tree. Returns the tree id. */
  async take(signal?: AbortSignal): Promise<string> {
    await this.init(signal);
    // Count first: the first `git add` of a huge folder would be slow.
    const list = "ls-files --cached --others --exclude-standard";
    const count = Number.parseInt(await this.git(`${list} | wc -l`, signal), 10);
    if (count > this.maxFiles) {
      throw new SnapshotError(
        `The project has ${count} files (more than ${this.maxFiles}); add big folders to .gitignore.`,
      );
    }
    await this.git("add -A -- .", signal);
    const id = (await this.git("write-tree", signal)).trim();
    // Pack now and then; git prunes unused snapshots after two weeks (its default).
    if (++this.taken % GC_EVERY === 0) await this.git("gc --auto --quiet", signal);
    return id;
  }

  /** The files that differ between two snapshots, from → to. */
  async changes(from: string, to: string, signal?: AbortSignal): Promise<FileChange[]> {
    await this.init(signal);
    const out = await this.git(
      `diff-tree -r -z --no-renames --name-status ${tree(from)} ${tree(to)}`,
      signal,
    );
    const parts = out.split("\0").filter((p) => p !== "");
    const changes: FileChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i];
      const path = parts[i + 1] as string;
      const status = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
      changes.push({ status, path });
    }
    return changes;
  }

  /** The changes from → to with added and removed line counts (0.6, /diff). */
  async stats(from: string, to: string, signal?: AbortSignal): Promise<FileStat[]> {
    const changes = await this.changes(from, to, signal);
    const out = await this.git(
      `diff-tree -r -z --no-renames --numstat ${tree(from)} ${tree(to)}`,
      signal,
    );
    // -z --numstat: "added<TAB>removed<TAB>path<NUL>"; binary files give "-<TAB>-".
    const counts = new Map<string, { added?: number; removed?: number }>();
    for (const entry of out.split("\0")) {
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(entry);
      if (match === null) continue;
      counts.set(
        match[3] as string,
        match[1] === "-" ? {} : { added: Number(match[1]), removed: Number(match[2]) },
      );
    }
    return changes.map((c) => ({ ...c, ...counts.get(c.path) }));
  }

  /** The unified diff from → to, of all files or of one path (0.6, /diff). No color, no textconv. */
  async patch(from: string, to: string, path?: string, signal?: AbortSignal): Promise<string> {
    // :(literal): the path is a file name, never a glob or other pathspec magic.
    const only = path === undefined ? "" : ` -- ${shellQuote(`:(literal)${path}`)}`;
    return this.git(
      `diff-tree -r -p --no-renames --no-color --no-ext-diff --no-textconv ${tree(from)} ${tree(to)}${only}`,
      signal,
    );
  }

  /**
   * Move the work tree from snapshot `from` to snapshot `to`. `from` must be the state now (take()
   * just before), so git can check that no file changed in between.
   */
  async restore(from: string, to: string, signal?: AbortSignal): Promise<void> {
    await this.init(signal);
    await this.git(`read-tree -m -u ${tree(from)} ${tree(to)}`, signal);
  }

  private init(signal?: AbortSignal): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await this.git("init -q", signal, true);
      await writeFile(join(this.dir, "info", "exclude"), `${SNAPSHOT_EXCLUDES.join("\n")}\n`);
    })().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async git(args: string, signal?: AbortSignal, initializing = false): Promise<string> {
    if (!initializing) await this.ready;
    const config = [
      "core.hooksPath=/dev/null",
      "core.fsmonitor=false",
      "core.autocrlf=false",
      "core.symlinks=true",
      "core.quotepath=off",
      "gc.auto=256",
      "user.name=Garuda",
      "user.email=garuda@localhost",
    ]
      .map((c) => `-c ${c}`)
      .join(" ");
    const policy: ExecPolicy = {
      root: this.root,
      sandbox: false,
      writePaths: [],
      denyWritePaths: [],
      denyReadPaths: [],
      network: false,
      envAllowlist: [...DEFAULT_ENV_ALLOWLIST],
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: 5_000_000,
    };
    const command = `git ${config} ${args}`;
    const result = await this.executor.run(command, policy, {
      ...(signal === undefined ? {} : { signal }),
      env: {
        GIT_DIR: this.dir,
        GIT_WORK_TREE: this.root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    if (result.aborted) throw signal?.reason ?? new Error("stopped");
    if (result.exitCode !== 0) {
      const why = (result.stderr.text || result.stdout.text).trim().split("\n").slice(-3).join(" ");
      throw new SnapshotError(
        result.timedOut ? `git took longer than ${GIT_TIMEOUT_MS / 1000} s.` : `git failed: ${why}`,
      );
    }
    return result.stdout.text;
  }
}

/** ~/.garuda/snapshots/<first 16 hex of sha256(root)>. */
export function storeDir(root: string, home: string = homedir()): string {
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(home, ".garuda", "snapshots", id);
}

/** One shell word: the path for /diff comes from the user. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** A tree id from our own records; checked, because it goes into a command line. */
function tree(id: string): string {
  if (!/^[0-9a-f]{40,64}$/.test(id)) throw new SnapshotError(`Not a snapshot id: ${id}`);
  return id;
}
