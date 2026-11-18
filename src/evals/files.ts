import { mkdirSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Write a task's files into a folder. A script (it starts with `#!`) can run: `./gradlew`. */
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    await writeFile(full, content);
    if (content.startsWith("#!")) await chmod(full, 0o755);
  }
}
