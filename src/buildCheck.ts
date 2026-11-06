import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "./jobs/git.js";
import { HostExecutor } from "./sandbox/host.js";

/** Garuda's git commit when it runs from a checkout; undefined from the npm package. */
export async function garudaCommit(): Promise<string | undefined> {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, ".git"))) {
      const r = await git(new HostExecutor(), dir, ["rev-parse", "HEAD"], { check: false });
      return r.exitCode === 0 ? r.stdout.trim() : undefined;
    }
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * A warning when the build is older than the checkout (0.17 for evals; 0.18.1 for the chat: the
 * user ran an old dist/ after a new patch). `what` says what is old.
 */
export function staleBuildNote(
  build: string | undefined,
  checkout: string | undefined,
  what = "The tasks and the code that run are the older ones",
): string | undefined {
  if (build === undefined || checkout === undefined || build === checkout) return undefined;
  return `This build is from commit ${build.slice(0, 7)}, but the checkout is at ${checkout.slice(0, 7)}. ${what}: run pnpm build first.`;
}

/** The chat's text: the code that runs is older than the checkout. */
export const CHAT_STALE = "The code that runs is the older one";
