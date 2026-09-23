import type { CapturedOutput } from "./types.js";

/**
 * Keep the first and the last part of a stream, within `maxBytes`.
 * The start shows what the command did. The end shows how it finished (for example a test summary).
 */
export class OutputCapture {
  private readonly headMax: number;
  private readonly tailMax: number;
  private head = Buffer.alloc(0);
  private tail: Buffer[] = [];
  private tailSize = 0;
  private total = 0;

  constructor(maxBytes: number) {
    this.headMax = Math.ceil(maxBytes / 2);
    this.tailMax = Math.floor(maxBytes / 2);
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.head.length < this.headMax) {
      const room = this.headMax - this.head.length;
      this.head = Buffer.concat([this.head, rest.subarray(0, room)]);
      rest = rest.subarray(room);
    }
    if (rest.length === 0 || this.tailMax === 0) return;
    this.tail.push(rest);
    this.tailSize += rest.length;
    // Drop old tail chunks when they are no longer needed.
    while (this.tail.length > 1 && this.tailSize - (this.tail[0]?.length ?? 0) >= this.tailMax) {
      this.tailSize -= this.tail.shift()?.length ?? 0;
    }
  }

  result(): CapturedOutput {
    const tail = Buffer.concat(this.tail);
    const keptTail = tail.subarray(Math.max(0, tail.length - this.tailMax));
    const truncated = this.head.length + keptTail.length < this.total;
    if (!truncated) {
      return {
        text: Buffer.concat([this.head, keptTail]).toString("utf8"),
        truncated,
        totalBytes: this.total,
      };
    }
    const cut = this.total - this.head.length - keptTail.length;
    const text = `${this.head.toString("utf8")}\n… [${cut} bytes cut] …\n${keptTail.toString("utf8")}`;
    return { text, truncated, totalBytes: this.total };
  }
}
