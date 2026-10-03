import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const writes = vi.hoisted(() => [] as { path: string; mode: number | undefined }[]);
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    writeFile: (async (path: string, data: string, options?: { mode?: number }) => {
      writes.push({ path: String(path), mode: options?.mode });
      return real.writeFile(path, data, options as never);
    }) as typeof real.writeFile,
  };
});
const { writeFileAtomic } = await import("../src/tools/atomicWrite.js");

const base = mkdtempSync(join(tmpdir(), "garuda-atomic-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("writeFileAtomic (0.14.1, from Garuda's tools review)", () => {
  it("creates the temp file with the target's mode, so private content is never wider", async () => {
    const file = join(base, "secret.txt");
    writeFileSync(file, "old\n");
    chmodSync(file, 0o600);
    await writeFileAtomic(file, "new\n", { createOnly: false });
    expect(readFileSync(file, "utf8")).toBe("new\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const temp = writes.find((w) => w.path.includes(".garuda-"));
    expect(temp?.mode).toBe(0o600);
  });
});
