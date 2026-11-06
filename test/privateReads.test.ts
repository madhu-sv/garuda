import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoTaskReadDenials } from "../src/evals/repoTasks.js";
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
  it("deny the checkout except its links, other copies of the project, and the rest of home", () => {
    const home = tree([
      ".nvm/node",
      "dev/garuda/node_modules/",
      "dev/garuda/src/",
      "dev/garuda/.git/",
      "dev/garuda/package.json",
      "dev/garuda-live/src/",
      "Documents/",
      "Library/pnpm/.tools/pnpm/10.28.0/",
      "Library/Mail/",
    ]);
    const root = join(home, "dev", "garuda");
    const deny = repoTaskReadDenials(root, home);
    expect(deny).toEqual(
      expect.arrayContaining([
        join(root, "src"),
        join(root, ".git"),
        join(root, "package.json"),
        join(home, "dev", "garuda-live"),
        join(home, "Documents"),
      ]),
    );
    expect(deny).not.toContain(join(root, "node_modules"));
    expect(deny).not.toContain(join(home, ".nvm"));
    // pnpm runs a project's version from ~/Library/pnpm: with Library denied, every check failed.
    expect(deny.filter((p) => p.startsWith(join(home, "Library")))).toEqual([]);
    // Its personal parts stay denied by the rules of every sandboxed command.
    const all = sandboxPaths(join(base, "copy"), { denyRead: deny }, home).denyReadPaths;
    expect(all).toContain(join(home, "Library", "Mail"));
    expect(all).toContain(join(home, "Library", "Keychains"));
    expect(all).not.toContain(join(home, "Library", "pnpm"));
    // A checkout outside the home folder: only its own entries.
    const outside = tree(["node_modules/", "src/"]);
    expect(repoTaskReadDenials(outside, join(base, "nohome"))).toEqual([join(outside, "src")]);
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
