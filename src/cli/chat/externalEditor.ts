import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInTerminal } from "../../sandbox/terminal.js";

/**
 * Edit the prompt in the user's editor (0.6): Ctrl-G or /editor. The text goes into a temporary
 * file, the editor opens on the real terminal, and the saved text comes back into the input line
 * (it is not sent). $VISUAL, then $EDITOR, then vi.
 */

export interface EditorResult {
  text?: string;
  /** Why nothing came back: the editor failed or could not start. */
  problem?: string;
}

/** The editor command as argv: `code --wait` → ["code", "--wait"]. Quotes group words. */
export function editorCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.VISUAL || env.EDITOR || "vi").trim();
  return [...raw.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

export function editInEditor(
  text: string,
  options: {
    env?: NodeJS.ProcessEnv;
    run?: (argv: readonly string[]) => { exitCode: number | null; error?: string };
  } = {},
): EditorResult {
  const dir = mkdtempSync(join(tmpdir(), "garuda-prompt-"));
  const file = join(dir, "prompt.md");
  try {
    writeFileSync(file, text, { mode: 0o600 });
    const argv = [...editorCommand(options.env), file];
    const result = (options.run ?? runInTerminal)(argv);
    if (result.error !== undefined) {
      return { problem: `Could not start ${argv[0]}: ${result.error}. Set $EDITOR.` };
    }
    if (result.exitCode !== 0)
      return { problem: `${argv[0]} ended with code ${result.exitCode}; the line did not change.` };
    // Editors add a final new line: drop the trailing ones.
    return { text: readFileSync(file, "utf8").replace(/\n+$/, "") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
