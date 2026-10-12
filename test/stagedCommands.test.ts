import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HostExecutor } from "../src/sandbox/host.js";
import { StagedCommands } from "../src/staging/staged.js";

/**
 * Staged commands without a sandbox (0.17, review T5): the test writes the copy by hand, as a
 * command would, and checks the list, apply and discard.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-staged-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let count = 0;
async function setup(maxFiles?: number) {
  const dir = join(base, `s${count++}`);
  const root = join(dir, "project");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(root, ".gitignore"), "build/\n");
  const staged = await StagedCommands.start(root, {
    executor: new HostExecutor(),
    home: join(dir, "home"),
    ...(maxFiles === undefined ? {} : { maxFiles }),
  });
  const inCopy = (path: string) => join(staged.copy.path, path);
  const inProject = (path: string) => join(root, path);
  return { root, staged, inCopy, inProject };
}
const read = (path: string) => readFileSync(path, "utf8");

describe("staged commands: list, apply, discard", () => {
  it("a change, then discard: the project does not change and the copy goes back", async () => {
    const { staged, inCopy, inProject } = await setup();
    const pre = await staged.prepare();
    writeFileSync(inCopy("src/a.ts"), "export const a = 99;\n");
    const collected = await staged.collect(pre);
    if (!collected.complete) throw new Error(collected.reason);
    expect(collected.changes).toEqual([{ status: "modified", path: "src/a.ts" }]);
    expect(await staged.patch(pre, collected.post)).toContain("+export const a = 99;");
    await staged.discard(pre, collected);
    expect(read(inProject("src/a.ts"))).toBe("export const a = 1;\n");
    expect(read(inCopy("src/a.ts"))).toBe("export const a = 1;\n");
    await staged.remove();
  });

  it("apply: changed, added (in a new folder, executable) and deleted files reach the project", async () => {
    const { staged, inCopy, inProject } = await setup();
    const pre = await staged.prepare();
    writeFileSync(inCopy("src/a.ts"), "export const a = 99;\n");
    mkdirSync(inCopy("scripts"));
    writeFileSync(inCopy("scripts/run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(inCopy("scripts/run.sh"), 0o755);
    unlinkSync(inCopy("src/b.ts"));
    const collected = await staged.collect(pre);
    if (!collected.complete) throw new Error(collected.reason);
    expect(collected.changes).toEqual([
      { status: "added", path: "scripts/run.sh" },
      { status: "modified", path: "src/a.ts" },
      { status: "deleted", path: "src/b.ts" },
    ]);
    expect(await staged.apply(pre, collected.post, collected.changes)).toEqual({ applied: true });
    expect(read(inProject("src/a.ts"))).toBe("export const a = 99;\n");
    expect(read(inProject("scripts/run.sh"))).toBe("#!/bin/sh\necho hi\n");
    expect(statSync(inProject("scripts/run.sh")).mode & 0o111).not.toBe(0);
    expect(existsSync(inProject("src/b.ts"))).toBe(false);
    await staged.remove();
  });

  it("no change: an empty list", async () => {
    const { staged } = await setup();
    const pre = await staged.prepare();
    expect(await staged.collect(pre)).toMatchObject({ complete: true, changes: [] });
    await staged.remove();
  });

  it("ignored build output stays in the copy, is not listed, and the next command sees it", async () => {
    const { staged, inCopy, inProject } = await setup();
    const pre = await staged.prepare();
    mkdirSync(inCopy("build"));
    writeFileSync(inCopy("build/out.js"), "built\n");
    expect(await staged.collect(pre)).toMatchObject({ complete: true, changes: [] });
    await staged.prepare();
    expect(read(inCopy("build/out.js"))).toBe("built\n");
    expect(existsSync(inProject("build"))).toBe(false);
    await staged.remove();
  });

  it("an edit in the project (Garuda's edit_file, or the user) reaches the copy before the next command", async () => {
    const { staged, inCopy, inProject } = await setup();
    writeFileSync(inProject("src/a.ts"), "export const a = 2;\n");
    writeFileSync(inProject("src/c.ts"), "new\n");
    await staged.prepare();
    expect(read(inCopy("src/a.ts"))).toBe("export const a = 2;\n");
    expect(read(inCopy("src/c.ts"))).toBe("new\n");
    await staged.remove();
  });

  it("a conflict: the project file changed during the command; nothing is applied", async () => {
    const { staged, inCopy, inProject } = await setup();
    const pre = await staged.prepare();
    writeFileSync(inCopy("src/a.ts"), "from the command\n");
    writeFileSync(inCopy("src/b.ts"), "also from the command\n");
    writeFileSync(inProject("src/a.ts"), "from the user\n");
    const collected = await staged.collect(pre);
    if (!collected.complete) throw new Error(collected.reason);
    expect(await staged.apply(pre, collected.post, collected.changes)).toEqual({
      applied: false,
      reason: "these files changed in the project during the command",
      paths: ["src/a.ts"],
    });
    expect(read(inProject("src/a.ts"))).toBe("from the user\n");
    expect(read(inProject("src/b.ts"))).toBe("export const b = 2;\n");
    await staged.remove();
  });

  it("a link out of the project is refused; a link inside is applied", async () => {
    const { staged, inCopy, inProject } = await setup();
    const pre = await staged.prepare();
    symlinkSync("/etc/passwd", inCopy("out"));
    let collected = await staged.collect(pre);
    if (!collected.complete) throw new Error(collected.reason);
    expect(await staged.apply(pre, collected.post, collected.changes)).toMatchObject({
      applied: false,
      paths: ["out"],
    });
    expect(existsSync(inProject("out"))).toBe(false);
    await staged.discard(pre, collected);
    expect(existsSync(inCopy("out"))).toBe(false);

    const pre2 = await staged.prepare();
    symlinkSync("src/a.ts", inCopy("in"));
    collected = await staged.collect(pre2);
    if (!collected.complete) throw new Error(collected.reason);
    expect(await staged.apply(pre2, collected.post, collected.changes)).toEqual({ applied: true });
    expect(read(inProject("in"))).toBe("export const a = 1;\n");
    await staged.remove();
  });

  it("an incomplete list (over the file limit): discard still removes the command's files", async () => {
    const { staged, inCopy, inProject } = await setup(5);
    const pre = await staged.prepare();
    for (let i = 0; i < 10; i++) writeFileSync(inCopy(`f${i}.txt`), "x\n");
    writeFileSync(inCopy("src/a.ts"), "changed\n");
    const collected = await staged.collect(pre);
    expect(collected).toMatchObject({ complete: false });
    await staged.discard(pre, collected);
    expect(existsSync(inCopy("f0.txt"))).toBe(false);
    expect(read(inCopy("src/a.ts"))).toBe("export const a = 1;\n");
    expect(existsSync(inProject("f0.txt"))).toBe(false);
    await staged.remove();
  });

  it("a project over the file limit cannot be staged: start fails and leaves nothing", async () => {
    await expect(setup(1)).rejects.toThrow(/more than 1/);
  });
});
