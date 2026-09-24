import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * What the user approved, in ~/.garuda/trust.json (0.2). It lives in the home folder, so a
 * repository cannot approve its own servers. For each project root and server it keeps:
 *   def    the hash of the approved definition (command, args, env, network, writePaths)
 *   tools  the hash of the tool list seen at approval, to detect changed tools later
 * User servers are recorded under the key "~" (tools only; they need no consent).
 */
export const TRUST_FILE = join(".garuda", "trust.json");

const entry = z.object({ def: z.string().optional(), tools: z.string().optional() });
const schema = z.object({
  version: z.literal(1),
  mcp: z.record(z.string(), z.record(z.string(), entry)).default({}),
});
type TrustData = z.infer<typeof schema>;
export type TrustEntry = z.infer<typeof entry>;

export const USER_SCOPE = "~";

export class TrustStore {
  private data: TrustData = { version: 1, mcp: {} };

  private constructor(private readonly file: string) {}

  static async open(home: string = homedir()): Promise<TrustStore> {
    const store = new TrustStore(join(home, TRUST_FILE));
    try {
      const parsed = schema.safeParse(JSON.parse(await readFile(store.file, "utf8")));
      // A broken file trusts nothing: every project server asks again.
      if (parsed.success) store.data = parsed.data;
    } catch {
      // Missing or unreadable: start empty.
    }
    return store;
  }

  get(scope: string, server: string): TrustEntry {
    return this.data.mcp[scope]?.[server] ?? {};
  }

  async set(scope: string, server: string, value: TrustEntry): Promise<void> {
    const servers = this.data.mcp[scope] ?? {};
    this.data.mcp[scope] = servers;
    servers[server] = { ...servers[server], ...value };
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    // Write a private temp file, then rename it: never half a file, never readable by others.
    const temp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, this.file);
  }
}
