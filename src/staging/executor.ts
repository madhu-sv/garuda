import { sep } from "node:path";
import { isSensitive } from "../permissions/sensitive.js";
import type { ApprovalChoice, ApprovalRequest } from "../permissions/types.js";
import type {
  ExecOptions,
  ExecPolicy,
  ExecResult,
  Executor,
  RunningProcess,
} from "../sandbox/types.js";
import type { Collected, StagedCommands } from "./staged.js";

/**
 * The executor in staged mode (0.17, review T5). It wraps the OS sandbox executor. A command
 * that may write the project (sandboxed, with the root writable) runs in the staging copy; after
 * it, the user applies or discards what it changed. Everything else passes through unchanged:
 * commands outside the sandbox (they ask first, as before), read-only roots (plan mode), host
 * commands of Garuda's own (git for undo), and long-running programs (`start`: MCP servers,
 * language servers). Background daemons are off in staged mode: their writes would have no
 * question.
 *
 * - bubblewrap: the copy is mounted at the project's path, so the command sees the usual paths.
 * - Seatbelt cannot move a path: the command runs at the copy's path, and the project is
 *   read-only (user decision Q3).
 */

/** How the staging copy reaches the command: mounted at the root, or a working root of its own. */
export type StagingPlacement = "mount" | "move";

export type Ask = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalChoice>;

/** Most characters of the diff in the question. The file list always shows every file. */
const MAX_DIFF_CHARS = 60_000;

export class StagingExecutor implements Executor {
  readonly name: string;
  readonly isolation = "os" as const;
  /** No background daemons in staged mode. */
  readonly daemons = undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly inner: Executor,
    private readonly staged: StagedCommands,
    private readonly ask: Ask,
    private readonly placement: StagingPlacement = inner.name === "seatbelt" ? "move" : "mount",
  ) {
    this.name = inner.name;
  }

  run(command: string, policy: ExecPolicy, options: ExecOptions = {}): Promise<ExecResult> {
    if (!this.stages(policy)) return this.inner.run(command, policy, options);
    // One staged command at a time: each one compares the copy before and after.
    const next = this.queue.then(() => this.runStaged(command, policy, options));
    this.queue = next.catch(() => {});
    return next;
  }

  start(argv: string[], policy: ExecPolicy, env?: Record<string, string>): RunningProcess {
    return this.inner.start(argv, policy, env);
  }

  shutdown(): void {
    this.inner.shutdown();
  }

  /** Sandboxed, with the project writable: the command could change the project. */
  private stages(policy: ExecPolicy): boolean {
    return (
      policy.sandbox &&
      policy.root === this.staged.root &&
      policy.writeScope === undefined &&
      policy.writePaths.includes(this.staged.root)
    );
  }

  private async runStaged(
    command: string,
    policy: ExecPolicy,
    options: ExecOptions,
  ): Promise<ExecResult> {
    const signal = options.signal ?? new AbortController().signal;
    const pre = await this.staged.prepare(signal);
    const marker = await this.staged.mark();
    const result = await this.inner.run(
      command,
      stagedPolicy(policy, this.staged.copy.path, this.placement),
      options,
    );
    const collected = await this.staged.collect(pre, signal);
    if (collected.complete && collected.changes.length === 0) return result;
    const others = await this.staged.writtenSince(
      marker,
      collected.complete ? collected.changes : [],
      signal,
    );
    const note = await this.review(command, pre, collected, others, signal);
    return { ...result, staged: { note } };
  }

  /** Ask the user, then apply or discard. Returns the note for the model. */
  private async review(
    command: string,
    pre: string,
    collected: Collected,
    others: readonly string[],
    signal: AbortSignal,
  ): Promise<string> {
    let choice: ApprovalChoice = "deny";
    try {
      choice = await this.ask(await this.question(command, pre, collected, others, signal), signal);
    } catch {
      choice = "deny";
    }
    if (choice !== "deny" && collected.complete) {
      const applied = await this.staged.apply(pre, collected.post, collected.changes, signal);
      if (applied.applied) {
        return `Staged mode: the user applied the command's changes to the project (${count(collected.changes.length)}).`;
      }
      await this.staged.discard(pre, collected, signal);
      return `Staged mode: nothing was applied, because ${applied.reason}: ${applied.paths.join(", ")}. The command's changes are discarded; the project did not change by the command. Run it again if it is still needed.`;
    }
    await this.staged.discard(pre, collected, signal);
    return collected.complete
      ? "Staged mode: the user discarded the command's changes: the project did not change."
      : `Staged mode: Garuda could not list all changes (${collected.reason}), so they were discarded: the project did not change.`;
  }

  private async question(
    command: string,
    pre: string,
    collected: Collected,
    others: readonly string[],
    signal: AbortSignal,
  ): Promise<ApprovalRequest> {
    const notApplied = othersText(others);
    const base = {
      tool: "bash",
      target: { kind: "command" as const, command },
      isolation: "os" as const,
      title: "The command changed files",
    };
    if (!collected.complete) {
      return {
        ...base,
        preview: `$ ${command}\n\nGaruda could not list all changes: ${collected.reason}\nAn incomplete list cannot be applied.${notApplied}`,
        question: "Discard the changes?",
        choices: ["deny"],
        labels: { deny: "Discard" },
      };
    }
    const list = collected.changes.map((c) => `  ${c.status.padEnd(8)} ${c.path}`).join("\n");
    let diff = await this.staged.patch(pre, collected.post, signal);
    if (diff.length > MAX_DIFF_CHARS) {
      diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n… (the diff is cut; the list above has every file)`;
    }
    return {
      ...base,
      preview: `$ ${command}\n\n${count(collected.changes.length)}:\n${list}${notApplied}\n\n${diff}`,
      question: "Apply these changes to the project?",
      choices: ["once", "deny"],
      labels: { once: "Apply", deny: "Discard" },
    };
  }
}

/**
 * The command's policy in the staging copy. "mount": the copy is mounted over the root (bubblewrap),
 * paths stay. "move": the copy is the working root; the project's paths move to the copy, and the
 * project itself is read-only.
 */
export function stagedPolicy(
  policy: ExecPolicy,
  copy: string,
  placement: StagingPlacement,
): ExecPolicy {
  const root = policy.root;
  if (placement === "mount") {
    return { ...policy, mounts: [...(policy.mounts ?? []), { source: copy, target: root }] };
  }
  const inRoot = (p: string) => p === root || p.startsWith(`${root}${sep}`);
  const moved = (p: string) => (inRoot(p) ? copy + p.slice(root.length) : p);
  return {
    ...policy,
    root: copy,
    writePaths: [...new Set(policy.writePaths.map(moved))],
    // The project stays read-only, also when a writable parent (a temp folder) holds it.
    denyWritePaths: [
      ...new Set([root, ...policy.denyWritePaths, ...policy.denyWritePaths.map(moved)]),
    ],
    denyReadPaths: [...new Set([...policy.denyReadPaths, ...policy.denyReadPaths.map(moved)])],
  };
}

/**
 * Files that the command wrote but that are never applied: those that git ignores, and `.git`.
 * Sensitive ones by name (they may hold secrets the command wrote); the rest as a count per top
 * folder ("build/: 212 files").
 */
export function othersText(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const sensitive = paths.filter((p) => isSensitive(p));
  const folders = new Map<string, number>();
  for (const p of paths) {
    if (sensitive.includes(p)) continue;
    const slash = p.indexOf("/");
    const top = slash < 0 ? p : `${p.slice(0, slash)}/`;
    folders.set(top, (folders.get(top) ?? 0) + 1);
  }
  const lines = [
    "",
    "",
    "Not applied (git ignores them, or .git); they stay in the staging copy:",
    ...[...folders]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([top, n]) => `  ${top}: ${count(n)}`),
    ...sensitive.map((p) => `  sensitive: ${p}`),
  ];
  return lines.join("\n");
}

const count = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
