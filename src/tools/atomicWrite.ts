import { randomBytes } from "node:crypto";
import { chmod, link, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Write a file so that it is never half-written (F4): write a temporary file in the same
 * folder, then move it into place in one step. If Garuda stops during the write, the old
 * file stays as it was.
 *
 * createOnly: fail with EEXIST when the file exists (a hard link does this in one step).
 * Otherwise replace the file and keep its permissions. A symbolic link stays a link:
 * the write goes to the file it points to.
 */
export async function writeFileAtomic(
  path: string,
  content: string,
  { createOnly }: { createOnly: boolean },
): Promise<void> {
  const target = createOnly ? path : await realpath(path);
  const temp = join(
    dirname(target),
    `.${basename(target)}.garuda-${randomBytes(4).toString("hex")}.tmp`,
  );
  await writeFile(temp, content, { flag: "wx" });
  try {
    if (createOnly) {
      try {
        await link(temp, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Some file systems (FAT, some network mounts) have no hard links.
        if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV") throw error;
        if (await exists(target)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        await rename(temp, target);
        return;
      }
    } else {
      await chmod(temp, (await stat(target)).mode & 0o7777);
      await rename(temp, target);
      return;
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
