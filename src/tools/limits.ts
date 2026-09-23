/** Output limits keep tool results small enough for the context window. */
export const LIMITS = {
  /** Maximum characters in one tool result. */
  outputChars: 50_000,
  /** read_file: default and maximum lines per call. */
  readLines: 2_000,
  /** read_file and grep: longer lines are cut. */
  lineChars: 2_000,
  /** read_file: larger files are refused. */
  readFileBytes: 10 * 1024 * 1024,
  /** grep: larger files are skipped. */
  grepFileBytes: 1024 * 1024,
  /** glob: maximum paths returned. */
  globResults: 200,
  /** grep: default and maximum results. */
  grepResults: 100,
  grepResultsMax: 500,
} as const;

export function cutLine(line: string, max: number = LIMITS.lineChars): string {
  return line.length <= max ? line : `${line.slice(0, max)}… [line cut at ${max} characters]`;
}

/** Join lines until the character limit. Report how many lines did not fit. */
export function joinWithinLimit(
  lines: readonly string[],
  maxChars: number = LIMITS.outputChars,
): { text: string; omitted: number } {
  let size = 0;
  let count = 0;
  for (const line of lines) {
    if (size + line.length + 1 > maxChars) break;
    size += line.length + 1;
    count++;
  }
  return { text: lines.slice(0, count).join("\n"), omitted: lines.length - count };
}

/** A file is binary when its first 8 KB contain a NUL byte. */
export function looksBinary(buffer: Uint8Array): boolean {
  const end = Math.min(buffer.length, 8192);
  for (let i = 0; i < end; i++) if (buffer[i] === 0) return true;
  return false;
}

export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  // A final newline does not start a new line.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}
