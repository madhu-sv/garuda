import { mkdir, readlink, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_ENV_ALLOWLIST } from "../permissions/engine.js";
import type { ExecPolicy, Executor } from "../sandbox/types.js";
import { MAX_SNAPSHOT_FILES, SNAPSHOT_EXCLUDES } from "../undo/snapshots.js";
import { StagingCopy, StagingError, type StagingOptions } from "./copy.js";

/**
 * Staged commands (0.17, review T5; docs/lld/bounded-changes.md). A command runs in the staging
 * copy; Garuda lists what changed there and applies it to the project only after a yes.
 *
 * Git does the file work, with a store of Garuda's own next to the copy (never the project's .git),
 * one index per work tree:
 *
 * - prepare(): the project's tree P and the copy's tree C. When they differ (Garuda's own edits,
 *   an earlier apply, the user's edits), `read-tree -m -u C P` brings the copy to P. P is the
 *   state before the command.
 * - collect(): the copy's tree after the command, and the changes from P. .gitignore applies: an
 *   ignored file (build output) stays in the copy and is never applied (user decision Q1).
 * - apply(): all or nothing (Q2). A path that also changed in the project since P is a conflict:
 *   nothing is applied. A link that points out of the root is refused. Then `read-tree -m -u` on
 *   the project, from its tree now to that tree with the command's changes.
 * - discard(): the copy goes back to P.
 *
 * The store is outside the copy, and sandbox commands cannot write it.
 */

const GIT_TIMEOUT_MS = 120_000;

export type StagedChange = { status: "added" | "modified" | "deleted"; path: string };

export type Collected =
  | { complete: true; post: string; changes: StagedChange[] }
  | { complete: false; reason: string };

export type Applied = { applied: true } | { applied: false; reason: string; paths: string[] };

export class StagedCommands {
  private constructor(
    readonly copy: StagingCopy,
    private readonly executor: Executor,
    private readonly store: string,
    private readonly maxFiles: number,
  ) {}

  /** Make the staging copy and its store. Throws StagingError: the session must not start. */
  static async start(
    root: string,
    options: StagingOptions & { maxFiles?: number },
  ): Promise<StagedCommands> {
    const copy = await StagingCopy.create(root, options);
    const staged = new StagedCommands(
      copy,
      options.executor,
      `${copy.path}.git`,
      options.maxFiles ?? MAX_SNAPSHOT_FILES,
    );
    try {
      await mkdir(staged.store, { recursive: true, mode: 0o700 });
      await staged.git(root, "init -q");
      await writeFile(join(staged.store, "info", "exclude"), `${SNAPSHOT_EXCLUDES.join("\n")}\n`);
      // Both lists must be complete now; a project over the limit cannot be staged.
      await staged.prepare();
    } catch (error) {
      await staged.remove();
      throw error instanceof StagingError
        ? error
        : new StagingError(`Garuda could not set up the staging copy: ${(error as Error).message}`);
    }
    return staged;
  }

  get root(): string {
    return this.copy.root;
  }

  /** Bring the copy to the project's state. Returns that tree: the state before the command. */
  async prepare(signal?: AbortSignal): Promise<string> {
    const project = await this.tree(this.root, signal);
    const copy = await this.tree(this.copy.path, signal);
    if (project !== copy)
      await this.git(this.copy.path, `read-tree -m -u ${copy} ${project}`, signal);
    return project;
  }

  /** What the command changed in the copy since `pre`. Incomplete: Garuda cannot list it all. */
  async collect(pre: string, signal?: AbortSignal): Promise<Collected> {
    try {
      const post = await this.tree(this.copy.path, signal);
      return { complete: true, post, changes: await this.changes(pre, post, signal) };
    } catch (error) {
      return { complete: false, reason: (error as Error).message };
    }
  }

  /** The unified diff pre → post, as the question shows it. */
  async patch(pre: string, post: string, signal?: AbortSignal): Promise<string> {
    return this.git(
      this.root,
      `diff-tree -r -p --no-renames --no-color --no-ext-diff --no-textconv ${id(pre)} ${id(post)}`,
      signal,
    );
  }

  /** Apply the command's changes to the project: all of them, or none. */
  async apply(
    pre: string,
    post: string,
    changes: readonly StagedChange[],
    signal?: AbortSignal,
  ): Promise<Applied> {
    const now = await this.tree(this.root, signal);
    const moved = new Set((await this.changes(pre, now, signal)).map((c) => c.path));
    const conflicts = changes.filter((c) => moved.has(c.path)).map((c) => c.path);
    if (conflicts.length > 0) {
      return {
        applied: false,
        reason: "these files changed in the project during the command",
        paths: conflicts,
      };
    }
    const links = await this.outsideLinks(post, changes, signal);
    if (links.length > 0) {
      return { applied: false, reason: "these links point out of the project", paths: links };
    }
    // The target: the project's tree now, with the command's changes on top.
    const index = join(this.store, "index-apply");
    await rm(index, { force: true });
    await this.git(this.root, `read-tree ${now}`, signal, index);
    const lines: string[] = [];
    const entries = await this.git(
      this.root,
      `ls-tree -r -z ${id(post)} -- ${changes
        .filter((c) => c.status !== "deleted")
        .map((c) => shellQuote(`:(literal)${c.path}`))
        .join(" ")}`,
      signal,
    );
    for (const entry of entries.split("\0")) if (entry !== "") lines.push(entry);
    for (const c of changes) {
      if (c.status === "deleted") lines.push(`0 ${"0".repeat(40)}\t${c.path}`);
    }
    // The list goes through a file in the store: paths may have any character but NUL.
    const list = join(this.store, "index-info");
    await writeFile(list, `${lines.join("\0")}\0`);
    await this.git(this.root, `update-index -z --index-info < ${shellQuote(list)}`, signal, index);
    await rm(list, { force: true });
    const target = (await this.git(this.root, "write-tree", signal, index)).trim();
    await rm(index, { force: true });
    await this.git(this.root, `read-tree -m -u ${now} ${id(target)}`, signal);
    return { applied: true };
  }

  /** The copy goes back to `pre`: the command's changes are gone. */
  async discard(pre: string, collected: Collected, signal?: AbortSignal): Promise<void> {
    if (collected.complete) {
      await this.git(this.copy.path, `read-tree -m -u ${id(collected.post)} ${id(pre)}`, signal);
      return;
    }
    // The list after the command failed: reset every listed file and remove new ones.
    await this.git(this.copy.path, `read-tree --reset -u ${id(pre)}`, signal);
    await this.git(this.copy.path, "clean -f -d -q", signal);
  }

  async remove(): Promise<void> {
    await rm(this.store, { recursive: true, force: true });
    await this.copy.remove();
  }

  private async tree(workTree: string, signal?: AbortSignal): Promise<string> {
    const count = Number.parseInt(
      await this.git(workTree, "ls-files --cached --others --exclude-standard | wc -l", signal),
      10,
    );
    if (count > this.maxFiles) {
      throw new StagingError(
        `The project has ${count} files (more than ${this.maxFiles}); add big folders to .gitignore.`,
      );
    }
    await this.git(workTree, "add -A -- .", signal);
    return id((await this.git(workTree, "write-tree", signal)).trim());
  }

  private async changes(from: string, to: string, signal?: AbortSignal): Promise<StagedChange[]> {
    const out = await this.git(
      this.root,
      `diff-tree -r -z --no-renames --name-status ${id(from)} ${id(to)}`,
      signal,
    );
    const parts = out.split("\0").filter((p) => p !== "");
    const changes: StagedChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i];
      const status = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
      changes.push({ status, path: parts[i + 1] as string });
    }
    return changes;
  }

  /** Links in `post` among the changes whose target is outside the project. */
  private async outsideLinks(
    post: string,
    changes: readonly StagedChange[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    const out: string[] = [];
    for (const c of changes) {
      if (c.status === "deleted") continue;
      const entry = await this.git(
        this.root,
        `ls-tree ${id(post)} -- ${shellQuote(`:(literal)${c.path}`)}`,
        signal,
      );
      if (!entry.startsWith("120000 ")) continue;
      const target = await readlink(join(this.copy.path, c.path)).catch(() => "");
      const where = resolve(this.root, c.path, "..", target);
      const inside = where === this.root || where.startsWith(`${this.root}${sep}`);
      if (
        target === "" ||
        isAbsolute(target) ||
        !inside ||
        relative(this.root, where).startsWith("..")
      ) {
        out.push(c.path);
      }
    }
    return out;
  }

  private git(
    workTree: string,
    args: string,
    signal?: AbortSignal,
    index?: string,
  ): Promise<string> {
    return this.run(workTree, args, signal, index);
  }

  private async run(
    workTree: string,
    args: string,
    signal: AbortSignal | undefined,
    index: string | undefined,
  ): Promise<string> {
    const config = [
      "core.hooksPath=/dev/null",
      "core.fsmonitor=false",
      "core.autocrlf=false",
      "core.symlinks=true",
      "core.quotepath=off",
      "gc.auto=0",
      "user.name=Garuda",
      "user.email=garuda@localhost",
    ]
      .map((c) => `-c ${c}`)
      .join(" ");
    const policy: ExecPolicy = {
      root: workTree,
      sandbox: false,
      writePaths: [],
      denyWritePaths: [],
      denyReadPaths: [],
      network: false,
      envAllowlist: [...DEFAULT_ENV_ALLOWLIST],
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: 20_000_000,
    };
    const command = `git ${config} ${args}`;
    const tag = workTree === this.root ? "project" : "copy";
    const result = await this.executor.run(command, policy, {
      ...(signal === undefined ? {} : { signal }),
      env: {
        GIT_DIR: this.store,
        GIT_WORK_TREE: workTree,
        GIT_INDEX_FILE: index ?? join(this.store, `index-${tag}`),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    if (result.aborted) throw signal?.reason ?? new Error("stopped");
    if (result.exitCode !== 0) {
      const why = (result.stderr.text || result.stdout.text).trim().split("\n").slice(-3).join(" ");
      throw new StagingError(
        result.timedOut ? `git took longer than ${GIT_TIMEOUT_MS / 1000} s.` : `git failed: ${why}`,
      );
    }
    return result.stdout.text;
  }
}

/** A tree id from our own git; checked, because it goes into a command line. */
function id(tree: string): string {
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new StagingError(`Not a tree id: ${tree}`);
  return tree;
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}
