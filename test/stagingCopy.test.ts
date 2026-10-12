import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HostExecutor } from "../src/sandbox/host.js";
import type { Executor } from "../src/sandbox/types.js";
import { rootId, StagingCopy, StagingError } from "../src/staging/copy.js";

/** The staging copy for staged commands (0.17, review T5). Temporary homes only. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-staging-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let count = 0;
function setup() {
  const dir = join(base, `c${count++}`);
  const root = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, ".env"), "KEY=x\n");
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  symlinkSync("src/a.ts", join(root, "link.ts"));
  return { root, home };
}
const executor = new HostExecutor();

describe("StagingCopy", () => {
  it("copies the whole project, dot files and links included; writes stay in the copy", async () => {
    const { root, home } = setup();
    const copy = await StagingCopy.create(root, { executor, home });
    expect(copy.path.startsWith(join(home, ".garuda", "staging", rootId(root)))).toBe(true);
    expect(readFileSync(join(copy.path, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(readFileSync(join(copy.path, ".env"), "utf8")).toBe("KEY=x\n");
    expect(existsSync(join(copy.path, ".git", "HEAD"))).toBe(true);
    expect(readlinkSync(join(copy.path, "link.ts"))).toBe("src/a.ts");
    writeFileSync(join(copy.path, "src", "a.ts"), "changed\n");
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    await copy.remove();
    expect(existsSync(copy.path)).toBe(false);
  });

  it("a plain copy over the limit stops: an error with the reason, no folder left", async () => {
    const { root, home } = setup();
    // "darwin" on Linux: the clone probe fails, so the copy would be plain.
    const made = StagingCopy.create(root, { executor, home, platform: "darwin", maxPlainBytes: 1 });
    await expect(made).rejects.toThrow(StagingError);
    await expect(made).rejects.toThrow(/plain staging copy is limited/);
    const left = readdirSync(join(home, ".garuda", "staging")).filter((n) => !n.startsWith("."));
    expect(left).toEqual([]);
  });

  it("a copy that fails: an error, no folder left", async () => {
    const { root, home } = setup();
    const failing: Executor = {
      ...executor,
      name: "fake",
      isolation: "none",
      run: (command, policy, options) =>
        command.includes("mkdir -m 700")
          ? executor.run("echo 'cp: no space left on device' >&2; exit 1", policy, options)
          : executor.run(command, policy, options),
      start: executor.start.bind(executor),
      shutdown: () => {},
    };
    await expect(StagingCopy.create(root, { executor: failing, home })).rejects.toThrow(
      /could not make the staging copy: cp: no space left on device/,
    );
    const left = readdirSync(join(home, ".garuda", "staging")).filter((n) => !n.startsWith("."));
    expect(left).toEqual([]);
  });

  it("removes copies of ended processes for the same project, keeps live ones and others", async () => {
    const { root, home } = setup();
    const staging = join(home, ".garuda", "staging");
    const id = rootId(root);
    for (const name of [`${id}-111-aa`, `${id}-222-bb`, `ffffffffffffffff-111-cc`]) {
      mkdirSync(join(staging, name), { recursive: true });
    }
    const copy = await StagingCopy.create(root, { executor, home, alive: (pid) => pid === 222 });
    const names = readdirSync(staging).sort();
    expect(names).toContain(`${id}-222-bb`);
    expect(names).toContain("ffffffffffffffff-111-cc");
    expect(names).not.toContain(`${id}-111-aa`);
    await copy.remove();
  });
});
