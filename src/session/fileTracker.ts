import { createHash } from "node:crypto";

/**
 * Remembers what the agent has seen of each file in this session.
 * - edit_file refuses a file that the agent did not read, or that changed after the read (F11).
 * - read_file does not send the same lines of an unchanged file twice (read deduplication).
 */
export class FileTracker {
  private readonly seen = new Map<string, string>();
  /** "path|offset|limit" → hash of the whole file at that read. */
  private readonly reads = new Map<string, string>();

  /** Record the content the agent now knows for `path` (absolute). */
  record(path: string, content: Buffer | string): void {
    this.seen.set(path, hash(content));
  }

  /** "unread", "changed" or "current". */
  status(path: string, content: Buffer | string): "unread" | "changed" | "current" {
    const known = this.seen.get(path);
    if (known === undefined) return "unread";
    return known === hash(content) ? "current" : "changed";
  }

  /**
   * Record a read of some lines. Returns true when the agent already read the same lines
   * of the same content, so the output is still in its context.
   */
  noteRead(path: string, content: Buffer | string, offset: number, limit: number): boolean {
    const key = `${path}|${offset}|${limit}`;
    const digest = hash(content);
    const repeat = this.reads.get(key) === digest;
    this.reads.set(key, digest);
    return repeat;
  }

  /**
   * Compaction cuts or summarises old tool outputs, so earlier reads may no longer be in the context.
   * The edit freshness records stay: they are about the file, not the context.
   */
  forgetReads(): void {
    this.reads.clear();
  }
}

function hash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}
