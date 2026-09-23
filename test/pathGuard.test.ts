import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  displayPath,
  isInside,
  PathOutsideRootError,
  resolveInRoot,
} from "../src/permissions/pathGuard.js";
import { makeSampleRepo } from "./sampleRepo.js";

const repo = makeSampleRepo();
afterAll(repo.cleanup);

describe("path guard (F15)", () => {
  it("accepts paths inside the root", async () => {
    expect(await resolveInRoot(repo.root, "src/config.ts")).toBe(join(repo.root, "src/config.ts"));
    expect(await resolveInRoot(repo.root, ".")).toBe(repo.root);
    expect(await resolveInRoot(repo.root, "")).toBe(repo.root);
    expect(await resolveInRoot(repo.root, "src/../README.md")).toBe(join(repo.root, "README.md"));
    expect(await resolveInRoot(repo.root, join(repo.root, "src"))).toBe(join(repo.root, "src"));
  });

  it("accepts a path that does not exist yet", async () => {
    expect(await resolveInRoot(repo.root, "new/dir/file.ts")).toBe(
      join(repo.root, "new/dir/file.ts"),
    );
  });

  it("rejects paths outside the root", async () => {
    for (const bad of ["..", "../outside/private.txt", "/etc/passwd", repo.outside]) {
      await expect(resolveInRoot(repo.root, bad)).rejects.toBeInstanceOf(PathOutsideRootError);
    }
  });

  it("rejects a symbolic link that leads outside the root", async () => {
    await expect(resolveInRoot(repo.root, "escape/private.txt")).rejects.toBeInstanceOf(
      PathOutsideRootError,
    );
    await expect(resolveInRoot(repo.root, "escape/new.txt")).rejects.toBeInstanceOf(
      PathOutsideRootError,
    );
  });

  it("isInside does not match a sibling with the same prefix", () => {
    expect(isInside("/a/repo", "/a/repo2/x")).toBe(false);
    expect(isInside("/a/repo", "/a/repo/x")).toBe(true);
  });

  it("displayPath uses forward slashes relative to the root", () => {
    expect(displayPath(repo.root, join(repo.root, "src", "config.ts"))).toBe("src/config.ts");
    expect(displayPath(repo.root, repo.root)).toBe(".");
  });
});
