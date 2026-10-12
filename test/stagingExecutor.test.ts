import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { bwrapArgs } from "../src/sandbox/bwrap.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { seatbeltProfile } from "../src/sandbox/seatbelt.js";
import type { ExecPolicy } from "../src/sandbox/types.js";
import { StagingExecutor, stagedPolicy } from "../src/staging/executor.js";
import { StagedCommands } from "../src/staging/staged.js";

/** The staged-mode executor (0.17, review T5), on any platform: "move" placement on the host. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-staging-exec-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let count = 0;
async function setup(maxFiles?: number) {
  const dir = join(base, `e${count++}`);
  const root = join(dir, "project");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "a\n");
  const host = new HostExecutor();
  const staged = await StagedCommands.start(root, {
    executor: host,
    home: join(dir, "home"),
    ...(maxFiles === undefined ? {} : { maxFiles }),
  });
  return { root, staged, host };
}
const policy = (root: string, over: Partial<ExecPolicy> = {}): ExecPolicy => ({
  root,
  sandbox: true,
  writePaths: [root, "/tmp"],
  denyWritePaths: [join(root, ".git/hooks")],
  denyReadPaths: [join(root, "secret"), "/home/u/.ssh"],
  network: false,
  envAllowlist: ["PATH"],
  timeoutMs: 10_000,
  maxOutputBytes: 10_000,
  ...over,
});

describe("stagedPolicy", () => {
  it("mount: the copy over the root, paths unchanged; bubblewrap binds it after the writable paths", () => {
    const p = stagedPolicy(policy("/p"), "/s/copy", "mount");
    expect(p.root).toBe("/p");
    expect(p.mounts).toEqual([{ source: "/s/copy", target: "/p" }]);
    const args = bwrapArgs("true", p, () => "dir").join(" ");
    expect(args).toContain(
      "--bind /p /p --bind /tmp /tmp --bind /s/copy /p --ro-bind /p/.git/hooks",
    );
  });

  it("move: the copy is the root, paths move to it, the project is read-only", () => {
    const p = stagedPolicy(policy("/p"), "/s/copy", "move");
    expect(p.root).toBe("/s/copy");
    expect(p.writePaths).toEqual(["/s/copy", "/tmp"]);
    expect(p.denyWritePaths).toEqual(["/p", "/p/.git/hooks", "/s/copy/.git/hooks"]);
    expect(p.denyReadPaths).toEqual(["/p/secret", "/home/u/.ssh", "/s/copy/secret"]);
    const profile = seatbeltProfile(p);
    expect(profile).toContain('(deny file-write* (subpath "/p")');
  });
});

describe("StagingExecutor", () => {
  it("only sandboxed commands with a writable root are staged; daemons are off", async () => {
    const { root, staged, host } = await setup();
    const approver = new AutoApprover("deny");
    const executor = new StagingExecutor(host, staged, (r) => approver.ask(r), "move");
    expect(executor.daemons).toBeUndefined();
    // Outside the sandbox: the project itself, as before.
    await executor.run("echo x > src/a.ts", policy(root, { sandbox: false }));
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("x\n");
    // Read-only root (plan mode): not staged.
    const readOnly = await executor.run("pwd", policy(root, { writePaths: ["/tmp"] }));
    expect(readOnly.stdout.text.trim()).toBe(root);
    // Staged: it runs in the copy; discard keeps the project.
    const r = await executor.run("pwd && echo y > src/a.ts", policy(root));
    expect(r.stdout.text.trim()).toBe(staged.copy.path);
    expect(r.staged?.note).toContain("discarded");
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("x\n");
    await staged.remove();
  });

  it("an incomplete list offers only discard, and nothing is applied", async () => {
    const { root, staged, host } = await setup(3);
    const approver = new AutoApprover("once");
    const executor = new StagingExecutor(host, staged, (r) => approver.ask(r), "move");
    const r = await executor.run(
      "for i in 1 2 3 4 5; do echo $i > f$i; done; echo z > src/a.ts",
      policy(root),
    );
    const asked = approver.requests.at(-1);
    expect(asked?.choices).toEqual(["deny"]);
    expect(asked?.preview).toContain("An incomplete list cannot be applied");
    expect(r.staged?.note).toContain("could not list all changes");
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("a\n");
    await staged.remove();
  });

  it("the user stops at the question (Ctrl-C): the changes are discarded", async () => {
    const { root, staged, host } = await setup();
    const executor = new StagingExecutor(
      host,
      staged,
      async () => {
        throw new Error("aborted");
      },
      "move",
    );
    const r = await executor.run("echo q > src/a.ts", policy(root));
    expect(r.staged?.note).toContain("discarded");
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("a\n");
    expect(readFileSync(join(staged.copy.path, "src/a.ts"), "utf8")).toBe("a\n");
    await staged.remove();
  });
});
