import { createHash } from "node:crypto";

/**
 * Remembers what the agent last saw of each file in this session (F11).
 * edit_file refuses a file that the agent did not read, or that changed after the read.
 */
export class FileTracker {
  private readonly seen = new Map<string, string>();

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
}

function hash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}
