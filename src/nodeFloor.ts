/**
 * The Node.js release with the latest security fixes, per supported line (0.17). Garuda warns at
 * start when its Node is older than the entry of its line, or on a line that gets no fixes: Garuda
 * fetches untrusted pages, and Node's TLS, DNS and Brotli code then handles them.
 *
 * With each Node security release, update this table. The same change must update `engines` in
 * package.json (a test checks it); the CI check (scripts/check-node.mjs) reads this file.
 */
export const NODE_SECURITY = {
  date: "2026-10-21",
  advisory: "https://nodejs.org/en/blog/vulnerability/october-2026-security-releases",
  lines: { 22: "22.23.4", 24: "24.22.1", 26: "26.12.1" } as Readonly<Record<number, string>>,
} as const;

/** A reason not to run on this Node, or undefined when it has the latest known fixes. */
export function nodeProblem(version: string = process.versions.node): string | undefined {
  const [major = 0] = parse(version);
  const lines = Object.keys(NODE_SECURITY.lines).map(Number);
  const floor = NODE_SECURITY.lines[major];
  const use = `Use Node ${lines.map((l) => NODE_SECURITY.lines[l]).join(", ")} or later.`;
  if (floor === undefined) {
    // A line newer than this table: Garuda cannot judge it.
    if (major > Math.max(...lines)) return undefined;
    return `Node ${version} gets no security fixes (Garuda supports ${lines.join(", ")}). ${use}`;
  }
  if (compare(parse(version), parse(floor)) < 0) {
    return `Node ${version} does not have the security fixes of ${NODE_SECURITY.date} (${NODE_SECURITY.advisory}). Update to ${floor} or later.`;
  }
  return undefined;
}

/** `engines.node` in package.json for this table. */
export function enginesRange(): string {
  const entries = Object.entries(NODE_SECURITY.lines);
  return entries.map(([, v], i) => (i === entries.length - 1 ? `>=${v}` : `^${v}`)).join(" || ");
}

function parse(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => Number.parseInt(n, 10) || 0);
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
