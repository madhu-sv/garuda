import { Worker } from "node:worker_threads";

/**
 * Runs grep's regular expression in a worker thread (0.14.1, review). JavaScript cannot stop a
 * regular expression in the middle of a match, so a pattern that backtracks badly, such as
 * `(a+)+$`, blocked Garuda's event loop: Ctrl-C and timeouts did not work. In a worker, Garuda
 * stays responsive and ends the worker on Ctrl-C or when one file takes too long.
 */
const SOURCE = `
const { parentPort } = require("node:worker_threads");
let regex;
parentPort.on("message", (message) => {
  if (message.pattern !== undefined) {
    regex = new RegExp(message.pattern, message.flags);
    return;
  }
  const hits = [];
  const lines = message.lines;
  for (let i = 0; i < lines.length; i++) if (regex.test(lines[i])) hits.push(i);
  parentPort.postMessage(hits);
});
`;

/** The longest time for the lines of one file, in milliseconds. */
export const REGEX_FILE_MS = 10_000;

export class RegexMatcher {
  private readonly worker: Worker;
  private pending: { resolve: (hits: number[]) => void; reject: (error: unknown) => void } | null =
    null;
  private failure: unknown;
  private readonly onAbort = () => this.fail(this.signal.reason);

  /** The pattern is checked by the caller (new RegExp) before a matcher is made. */
  constructor(
    pattern: string,
    flags: string,
    private readonly signal: AbortSignal,
    private readonly timeoutMs: number = REGEX_FILE_MS,
  ) {
    this.worker = new Worker(SOURCE, { eval: true });
    this.worker.unref();
    this.worker.on("message", (hits: number[]) => {
      const pending = this.pending;
      this.pending = null;
      pending?.resolve(hits);
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.postMessage({ pattern, flags });
    signal.addEventListener("abort", this.onAbort, { once: true });
  }

  /** The indexes of the lines that match. */
  match(lines: string[], file: string): Promise<number[]> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            new Error(
              `The pattern took more than ${this.timeoutMs / 1000} s on ${file}. It may backtrack too much (for example a nested repeat like (a+)+). Make it simpler.`,
            ),
          ),
        this.timeoutMs,
      );
      this.pending = {
        resolve: (hits) => {
          clearTimeout(timer);
          resolve(hits);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.worker.postMessage({ lines });
    });
  }

  close(): void {
    this.signal.removeEventListener("abort", this.onAbort);
    void this.worker.terminate();
  }

  private fail(error: unknown): void {
    this.failure ??= error;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(this.failure);
    this.close();
  }
}
