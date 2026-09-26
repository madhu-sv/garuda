import { spawnSync } from "node:child_process";

/**
 * Run a program on the user's terminal and wait for it (0.6): the user's own editor for a long
 * prompt (Ctrl-G, /editor). It gets the real terminal (stdin, stdout, stderr), so it cannot run in
 * the sandbox or through the Executor, which capture output. Only the chat calls it, on a key the
 * user pressed; the model never can. It lives here because only src/sandbox starts processes (N8).
 */
export function runInTerminal(argv: readonly string[]): {
  exitCode: number | null;
  error?: string;
} {
  const [program, ...args] = argv;
  if (program === undefined) return { exitCode: null, error: "no program" };
  const result = spawnSync(program, args, { stdio: "inherit" });
  if (result.error !== undefined) return { exitCode: null, error: result.error.message };
  return { exitCode: result.status };
}
