import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoTaskReadDenials } from "../src/evals/repoTasks.js";
import { repoTaskSandbox } from "../src/evals/runner.js";
import {
  denyAround,
  PERSONAL_IN_HOME,
  personalDenials,
  sandboxPaths,
} from "../src/permissions/sandboxPaths.js";
import { seatbeltProfile, withDataVolume } from "../src/sandbox/seatbelt.js";

/**
 * 0.18.1: sandboxed commands cannot read the user's personal folders, and a repo eval cannot read
 * the project's checkout or the rest of the home folder (a model's `find /` in an eval made macOS
 * ask for Downloads and Photos, and it copied files from the user's live checkout).
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-private-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
/** A fake home folder with the given entries (folders end with /). */
function tree(entries: string[]): string {
  const home = join(base, `home-${++n}`);
  for (const e of entries) {
    const path = join(home, e);
    if (e.endsWith("/")) mkdirSync(path, { recursive: true });
    else {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "x");
    }
  }
  return home;
}

describe("personal folders", () => {
  it("are denied whole when the project is elsewhere", () => {
    const home = "/home/u";
    const deny = sandboxPaths("/home/u/dev/p", {}, home).denyReadPaths;
    for (const name of PERSONAL_IN_HOME) expect(deny).toContain(join(home, name));
    expect(deny).toContain("/home/u/Pictures"); // the Photos library is in it
    expect(deny).toContain("/home/u/Library/Mobile Documents"); // iCloud Drive
  });

  it("a project inside Documents: everything there is denied except the way to the project", () => {
    const home = tree([
      "Documents/work/proj/src/a.ts",
      "Documents/work/other/b.txt",
      "Documents/tax.pdf",
      "Downloads/x.zip",
    ]);
    const root = join(home, "Documents", "work", "proj");
    const deny = personalDenials(home, root);
    expect(deny).toContain(join(home, "Documents", "tax.pdf"));
    expect(deny).toContain(join(home, "Documents", "work", "other"));
    expect(deny).toContain(join(home, "Downloads"));
    expect(deny).not.toContain(join(home, "Documents"));
    expect(deny).not.toContain(join(home, "Documents", "work"));
    expect(deny.some((p) => p.startsWith(root))).toBe(false);
    // A project that is the folder itself keeps it.
    expect(personalDenials(home, join(home, "Documents"))).not.toContain(join(home, "Documents"));
  });

  it("denyAround keeps hidden entries only where asked", () => {
    const home = tree([".nvm/", "dev/p/node_modules/", "dev/p/.git/", "dev/p/src/", "notes.txt"]);
    const keep = [join(home, "dev", "p", "node_modules")];
    const deny = denyAround(home, keep, true);
    expect(deny).toEqual(
      expect.arrayContaining([
        join(home, "notes.txt"),
        join(home, "dev", "p", ".git"),
        join(home, "dev", "p", "src"),
      ]),
    );
    expect(deny).not.toContain(join(home, ".nvm"));
    expect(deny).not.toContain(keep[0]);
    expect(denyAround(join(base, "missing"), [])).toEqual([]);
  });
});

describe("repo evals", () => {
  it("in the home folder: no denials of their own, as needed reads hide the rest (T15 step 3)", () => {
    const home = tree(["dev/garuda/node_modules/", "dev/garuda/src/", "Documents/"]);
    expect(repoTaskReadDenials(join(home, "dev", "garuda"), home)).toEqual([]);
    expect(repoTaskSandbox(join(home, "dev", "garuda"), home)).toMatchObject({ reads: "needed" });
    expect(repoTaskSandbox(join(home, "dev", "garuda"), home)).not.toHaveProperty("denyRead");
  });

  it("outside the home folder: the checkout's own entries, not its links", () => {
    const outside = tree(["node_modules/", "src/"]);
    const home = join(base, "nohome");
    expect(repoTaskReadDenials(outside, home)).toEqual([join(outside, "src")]);
    expect(repoTaskSandbox(outside, home)).toMatchObject({
      reads: "needed",
      denyRead: [join(outside, "src")],
    });
  });
});

describe("the macOS data volume", () => {
  it("each denied path under /Users is also denied under /System/Volumes/Data", () => {
    expect(withDataVolume(["/Users/m/.ssh", "/opt/x"])).toEqual([
      "/Users/m/.ssh",
      "/System/Volumes/Data/Users/m/.ssh",
      "/opt/x",
    ]);
    const profile = seatbeltProfile({
      root: "/Users/m/dev/p",
      sandbox: true,
      writePaths: ["/Users/m/dev/p"],
      denyWritePaths: ["/Users/m/dev/p/.git/hooks"],
      denyReadPaths: ["/Users/m/Downloads"],
      network: false,
      envAllowlist: [],
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    });
    expect(profile).toContain(
      '(deny file-read* (subpath "/Users/m/Downloads") (subpath "/System/Volumes/Data/Users/m/Downloads"))',
    );
    expect(profile).toContain('(subpath "/System/Volumes/Data/Users/m/dev/p/.git/hooks")');
  });
});
