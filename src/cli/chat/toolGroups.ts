import type { ToolUseBlock } from "../../model/types.js";
import { summariseCall } from "../renderer.js";
import type { Paint } from "./markdown.js";

/**
 * Grouped tool lines (UX U4; docs/lld/ux.md): calls of one read-only tool that come one after
 * another become one line in the scrollback, "● Read 4 files  src/a.ts, src/b.ts, +2". Edits,
 * commands and failed calls always keep a line of their own: they are what the user checks.
 */

const GROUPS: Record<string, (n: number) => string> = {
  read_file: (n) => `Read ${n} files`,
  glob: (n) => `Listed files ${n} times`,
  grep: (n) => `Searched ${n} times`,
  find_symbol: (n) => `Looked up ${n} symbols`,
  find_references: (n) => `Found references ${n} times`,
  find_callers: (n) => `Found callers ${n} times`,
  repo_map: (n) => `Mapped the repository ${n} times`,
};

/** True for a tool whose calls group (read-only and frequent). */
export function groups(name: string): boolean {
  return Object.hasOwn(GROUPS, name);
}

/** What the calls were about, cut to `width` characters: "a.ts, b.ts, +2". */
export function groupTargets(calls: readonly ToolUseBlock[], width: number): string {
  const all = calls.map((c) => summariseCall(c)).filter((t) => t !== "");
  const shown: string[] = [];
  for (const [i, target] of all.entries()) {
    const rest = all.length - i - 1;
    const next = [...shown, target].join(", ");
    const tail = rest > 0 ? `, +${rest}` : "";
    if (shown.length > 0 && next.length + tail.length > width) {
      return `${shown.join(", ")}, +${all.length - i}`;
    }
    shown.push(target);
  }
  return shown.join(", ");
}

/** The one line of a group of two or more calls. */
export function groupLine(
  name: string,
  calls: readonly ToolUseBlock[],
  paint: Paint,
  columns: number,
): string {
  const head = GROUPS[name]?.(calls.length) ?? `${name} ×${calls.length}`;
  const room = Math.max(20, columns - head.length - 6);
  return `${paint("cyan", "●")} ${paint("bold", head)}  ${paint("dim", groupTargets(calls, room))}`;
}

/** The plan from a todo_write result, painted: done green, current yellow, open dim. */
export function planText(lines: readonly string[], paint: Paint): string {
  const painted = lines.map((line) =>
    line.startsWith("✔")
      ? paint("green", line)
      : line.startsWith("▶")
        ? paint("yellow", line)
        : paint("dim", line),
  );
  return [paint("bold", "Plan"), ...painted.map((l) => `  ${l}`)].join("\n");
}
