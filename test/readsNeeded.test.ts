import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PermissionEngine } from "../src/permissions/engine.js";
import { mergePolicies, parsePolicy } from "../src/permissions/policy.js";
import { settingsRisk, withoutRisk } from "../src/permissions/projectSettings.js";
import { hiddenPlaces, NEEDED_MODE_DENY, neededReads } from "../src/permissions/reads.js";
import { parseSettings } from "../src/permissions/settings.js";
import { bwrapArgs } from "../src/sandbox/bwrap.js";
import { findOsSandbox } from "../src/sandbox/index.js";
import {
  homeIsWritable,
  type ReadScope,
  readAncestors,
  writableInScope,
} from "../src/sandbox/readScope.js";
import { seatbeltProfile } from "../src/sandbox/seatbelt.js";
import type { ExecPolicy } from "../src/sandbox/types.js";

/** T15 (docs/lld/reads.md), step 1: the "needed" read mode. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-reads-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
/** A fake home folder with these entries (folders end with /). */
function fakeHome(entries: string[]): string {
  const home = join(base, `home-${++n}`);
  for (const e of entries) {
    const path = join(home, e);
    if (e.endsWith("/")) mkdirSync(path, { recursive: true });
    else {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "x\n");
    }
  }
  return home;
}

describe("what 'needed' mode reads", () => {
  it("the project and its links, toolchain prefixes on PATH, variables, the fixed list, readPaths", () => {
    const home = fakeHome([
      "dev/app/",
      "deps/node_modules/",
      ".nvm/versions/node/v22/bin/",
      "rust/cargo/",
      "notes/spec.md",
      "Documents/private.txt",
    ]);
    const root = join(home, "dev", "app");
    symlinkSync(join(home, "deps", "node_modules"), join(root, "node_modules"), "dir");
    const scope = neededReads({
      home,
      root,
      writePaths: [root, "/tmp"],
      readPaths: [join(home, "notes", "spec.md")],
      env: {
        PATH: `${join(home, ".nvm/versions/node/v22/bin")}:/usr/bin:relative/bin`,
        CARGO_HOME: join(home, "rust", "cargo"),
      },
      platform: "darwin",
    });
    expect(scope.home).toBe(home);
    expect(scope.allow).toEqual(
      expect.arrayContaining([
        root,
        join(home, "deps", "node_modules"),
        // A PATH entry that ends in bin gives its prefix, where npm's own modules are.
        join(home, ".nvm/versions/node/v22"),
        join(home, "rust", "cargo"),
        join(home, ".npm"),
        join(home, ".gradle", "caches"),
        join(home, ".garuda", "skills"),
        join(home, "notes", "spec.md"),
      ]),
    );
    // Not the home folder itself, nothing outside it, not the user's documents.
    expect(scope.allow).not.toContain(home);
    expect(scope.allow).not.toContain("/usr");
    expect(scope.allow).not.toContain("/tmp");
    expect(scope.allow.some((p) => p.includes("Documents"))).toBe(false);
    // The JVM folders' settings files are not under a readable folder.
    expect(scope.allow).not.toContain(join(home, ".m2"));
    expect(scope.allow).not.toContain(join(home, ".gradle"));
    expect(scope.hide).toEqual(["/Volumes"]);
  });

  it("hides other volumes, and a project on one stays readable", () => {
    expect(hiddenPlaces("darwin")).toEqual(["/Volumes"]);
    expect(hiddenPlaces("linux")).toEqual(["/media", "/mnt"]);
    expect(hiddenPlaces("win32")).toEqual([]);
    const home = fakeHome([]);
    const scope = neededReads({
      home,
      root: "/mnt/data/app",
      writePaths: ["/mnt/data/app"],
      readPaths: [],
      env: {},
      platform: "linux",
    });
    expect(scope.hide).toEqual(["/media", "/mnt"]);
    expect(scope.allow).toContain("/mnt/data/app");
  });
});

describe("the rule helpers", () => {
  const scope: ReadScope = {
    home: "/Users/me",
    allow: ["/Users/me/.nvm", "/Users/me/dev/app/node_modules"],
    hide: ["/Volumes"],
  };

  it("give the folders on the way, the write paths in scope, and a writable home", () => {
    expect(readAncestors(scope)).toEqual(["/Users/me", "/Users/me/dev", "/Users/me/dev/app"]);
    expect(readAncestors(scope, ["/Volumes/ext/p"])).toContain("/Volumes/ext");
    expect(writableInScope(scope, ["/Users/me/dev/app", "/tmp", "/Users/me"])).toEqual([
      "/Users/me/dev/app",
    ]);
    expect(homeIsWritable(scope, ["/tmp"])).toBe(false);
    expect(homeIsWritable(scope, ["/Users/me"])).toBe(true);
    expect(homeIsWritable(scope, ["/Users"])).toBe(true);
  });
});

const policy = (over: Partial<ExecPolicy> = {}): ExecPolicy => ({
  root: "/Users/me/dev/app",
  sandbox: true,
  writePaths: ["/Users/me/dev/app", "/tmp"],
  denyWritePaths: [],
  denyReadPaths: ["/Users/me/.ssh"],
  network: false,
  envAllowlist: ["PATH"],
  timeoutMs: 1_000,
  maxOutputBytes: 1_000,
  ...over,
});
const scope: ReadScope = { home: "/Users/me", allow: ["/Users/me/.nvm"], hide: ["/Volumes"] };

describe("Seatbelt", () => {
  it("denies the home folder, allows the readable paths, then the deny list wins", () => {
    const profile = seatbeltProfile(policy({ reads: scope })).split("\n");
    const deny = profile.findIndex((l) => l.startsWith('(deny file-read* (subpath "/Users/me")'));
    const allow = profile.findIndex((l) => l.startsWith("(allow file-read* "));
    const meta = profile.findIndex((l) => l.startsWith("(allow file-read-metadata "));
    const secrets = profile.findIndex((l) => l.includes('(subpath "/Users/me/.ssh")'));
    expect(deny).toBeGreaterThan(0);
    expect(allow).toBeGreaterThan(deny);
    expect(meta).toBeGreaterThan(allow);
    expect(secrets).toBeGreaterThan(meta);
    const lines = profile.join("\n");
    // Each path under /Users also through the data volume.
    expect(lines).toContain('(subpath "/System/Volumes/Data/Users/me")');
    expect(lines).toContain('(subpath "/Volumes")');
    // The project is readable as a write path in the home folder; /tmp is not added.
    expect(profile[allow]).toContain('(subpath "/Users/me/dev/app")');
    expect(profile[allow]).not.toContain('(subpath "/tmp")');
    expect(profile[meta]).toContain('(literal "/Users/me/dev")');
  });

  it("adds nothing in open mode, or when the home folder is writable", () => {
    expect(seatbeltProfile(policy())).not.toContain('(deny file-read* (subpath "/Users/me")');
    const open = seatbeltProfile(policy({ reads: scope, writePaths: ["/Users/me"] }));
    expect(open).not.toContain('(deny file-read* (subpath "/Users/me")');
  });
});

describe("bubblewrap", () => {
  const linux: ReadScope = { home: "/home/me", allow: ["/home/me/.nvm"], hide: ["/mnt"] };
  const p = policy({
    root: "/home/me/app",
    writePaths: ["/home/me/app", "/tmp"],
    denyReadPaths: ["/home/me/.ssh"],
    reads: linux,
  });

  it("empties the home folder, mounts the readable paths back, and makes it read-only last", () => {
    const args = bwrapArgs("make", p, () => "dir");
    const at = (...seq: string[]) =>
      args.findIndex((_, i) => seq.every((s, k) => args[i + k] === s));
    const tmpfs = at("--tmpfs", "/home/me");
    const nvm = at("--ro-bind", "/home/me/.nvm", "/home/me/.nvm");
    const project = at("--bind", "/home/me/app", "/home/me/app");
    const secret = at("--tmpfs", "/home/me/.ssh");
    const readOnly = at("--remount-ro", "/home/me");
    const net = args.indexOf("--unshare-net");
    expect(tmpfs).toBeGreaterThan(0);
    expect(at("--tmpfs", "/mnt")).toBeGreaterThan(0);
    expect(nvm).toBeGreaterThan(tmpfs);
    expect(project).toBeGreaterThan(nvm);
    expect(secret).toBeGreaterThan(project);
    expect(readOnly).toBeGreaterThan(secret);
    expect(net).toBeGreaterThan(readOnly);
  });

  it("does nothing in open mode, for a missing folder, or with a writable home", () => {
    const { reads: _r, ...openPolicy } = p;
    expect(bwrapArgs("make", openPolicy, () => "dir")).not.toContain("--remount-ro\u0000");
    expect(bwrapArgs("make", openPolicy, () => "dir").join(" ")).not.toContain("--tmpfs /home/me ");
    expect(bwrapArgs("make", p, () => undefined).join(" ")).not.toContain("--tmpfs /home/me");
    const writable = bwrapArgs("make", { ...p, writePaths: ["/home"] }, () => "dir").join(" ");
    expect(writable).not.toContain("--tmpfs /home/me ");
  });
});

describe("settings, policy and the engine", () => {
  const root = fakeHome(["proj/"]);

  it("settings take reads and readPaths; a project's readPaths need a yes", () => {
    const s = parseSettings({ sandbox: { reads: "needed", readPaths: ["~/notes"] } });
    expect(s.sandbox).toEqual({ reads: "needed", readPaths: ["~/notes"] });
    expect(() => parseSettings({ sandbox: { reads: "closed" } })).toThrow();
    expect(settingsRisk(s)?.readPaths).toEqual(["~/notes"]);
    expect(withoutRisk(s).sandbox).toEqual({ reads: "needed" });
    // The mode alone loosens nothing: no question.
    expect(settingsRisk(parseSettings({ sandbox: { reads: "needed" } }))).toBeUndefined();
  });

  it("a team policy can require the mode; it merges like requireSandbox", () => {
    expect(parsePolicy({ requireNeededReads: true }).requireNeededReads).toBe(true);
    expect(
      mergePolicies({ requireNeededReads: false }, { requireNeededReads: true })
        ?.requireNeededReads,
    ).toBe(true);
    expect(() => parsePolicy({ requireNeededReads: "yes" })).toThrow();
  });

  it("the engine adds the scope only in 'needed' mode and only in the sandbox", () => {
    const engine = (settings: unknown, team?: unknown) =>
      new PermissionEngine({
        root,
        approver: undefined as never,
        settings: parseSettings(settings),
        ...(team === undefined ? {} : { policy: parsePolicy(team) }),
      });
    expect(engine({}).execPolicy(1_000).reads).toBeUndefined();
    const needed = engine({ sandbox: { reads: "needed" } }).execPolicy(1_000);
    expect(needed.reads?.home).toBe(realpathSync(homedir()));
    // The mixed credential files are denied in this mode (decision 3).
    for (const file of NEEDED_MODE_DENY)
      expect(needed.denyReadPaths).toContain(join(homedir(), file));
    expect(
      engine({ sandbox: { reads: "needed" } }).execPolicy(1_000, { sandbox: false }).reads,
    ).toBeUndefined();
    // The team policy wins over the project's "open".
    expect(
      engine({ sandbox: { reads: "open" } }, { requireNeededReads: true }).execPolicy(1_000).reads,
    ).toBeDefined();
    // A file that readPaths names comes back.
    const back = engine({
      sandbox: { reads: "needed", readPaths: ["~/.gradle/gradle.properties"] },
    }).execPolicy(1_000);
    expect(back.denyReadPaths).not.toContain(join(homedir(), ".gradle/gradle.properties"));
    expect(back.denyReadPaths).toContain(join(homedir(), ".m2/settings.xml"));
  });
});

// A real command in this machine's sandbox, with a fake home folder in the temp folder.
const found = findOsSandbox();
const osExecutor = "executor" in found ? found.executor : undefined;

describe.runIf(osExecutor !== undefined)("'needed' mode in this machine's sandbox", () => {
  const executor = osExecutor as NonNullable<typeof osExecutor>;
  const home = fakeHome(["tools/bin/tool", "private/diary.txt", "proj/src/a.txt"]);
  const root = join(home, "proj");
  const run = (command: string) =>
    executor.run(command, {
      root,
      sandbox: true,
      // Not the temp folder: the fake home is in it, and a write path is readable.
      writePaths: [root],
      denyWritePaths: [],
      denyReadPaths: [],
      network: false,
      envAllowlist: ["PATH"],
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
      reads: { home, allow: [join(home, "tools")], hide: [] },
    });

  it("reads the project and the readable paths; not the rest of the home folder", async () => {
    expect((await run("cat src/a.txt")).stdout.text).toBe("x\n");
    expect((await run(`cat "${home}/tools/bin/tool"`)).stdout.text).toBe("x\n");
    const diary = await run(`cat "${home}/private/diary.txt"`);
    expect(diary.exitCode).not.toBe(0);
    expect(diary.stdout.text).not.toContain("x");
    // The home folder's listing shows no private entry (Linux shows the mount points only).
    const list = await run(`ls "${home}"`);
    expect(list.stdout.text).not.toContain("private");
    // A tool may stat the folders on the way (Node's realpath does).
    expect((await run(`test -d "${home}" && echo yes`)).stdout.text).toContain("yes");
  });

  it("a write to the home folder still fails, and the project stays writable", async () => {
    const r = await run(`echo y > "${home}/new.txt"`);
    expect(r.exitCode).not.toBe(0);
    expect(() => readFileSync(join(home, "new.txt"))).toThrow();
    expect((await run("echo z > out.txt && cat out.txt")).stdout.text).toBe("z\n");
  });
});
