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
 *   toolHashes  one hash per tool, to say which tools were added, removed or changed
 * User servers are recorded under the key "~" (tools only; they need no consent).
 * Project hooks and project slash commands (0.4) and project skills (0.5) keep the hash of what
 * the user allowed.
 */
export const TRUST_FILE = join(".garuda", "trust.json");

const entry = z.object({
  def: z.string().optional(),
  tools: z.string().optional(),
  /** A hash per tool name, to say which tools changed. */
  toolHashes: z.record(z.string(), z.string()).optional(),
});
const schema = z.object({
  version: z.literal(1),
  mcp: z.record(z.string(), z.record(z.string(), entry)).default({}),
  /** Project root → hash of the approved project hooks. */
  hooks: z.record(z.string(), z.string()).default({}),
  /** Project root → command name → hash of the approved command file (0.4). */
  commands: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  /** Project root → skill name → hash of the approved SKILL.md (0.5). */
  skills: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  /** Project root → agent name → hash of the approved agent file (0.5). */
  agents: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});
type TrustData = z.infer<typeof schema>;
export type TrustEntry = z.infer<typeof entry>;

export const USER_SCOPE = "~";

export class TrustStore {
  private data: TrustData = {
    version: 1,
    mcp: {},
    hooks: {},
    commands: {},
    skills: {},
    agents: {},
  };

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

  hooksHash(root: string): string | undefined {
    return this.data.hooks[root];
  }

  async setHooksHash(root: string, hash: string): Promise<void> {
    this.data.hooks[root] = hash;
    await this.save();
  }

  commandHash(root: string, name: string): string | undefined {
    return this.data.commands[root]?.[name];
  }

  async setCommandHash(root: string, name: string, hash: string): Promise<void> {
    const commands = this.data.commands[root] ?? {};
    this.data.commands[root] = commands;
    commands[name] = hash;
    await this.save();
  }

  skillHash(root: string, name: string): string | undefined {
    return this.data.skills[root]?.[name];
  }

  async setSkillHash(root: string, name: string, hash: string): Promise<void> {
    const skills = this.data.skills[root] ?? {};
    this.data.skills[root] = skills;
    skills[name] = hash;
    await this.save();
  }

  agentHash(root: string, name: string): string | undefined {
    return this.data.agents[root]?.[name];
  }

  async setAgentHash(root: string, name: string, hash: string): Promise<void> {
    const agents = this.data.agents[root] ?? {};
    this.data.agents[root] = agents;
    agents[name] = hash;
    await this.save();
  }

  async set(scope: string, server: string, value: TrustEntry): Promise<void> {
    const servers = this.data.mcp[scope] ?? {};
    this.data.mcp[scope] = servers;
    servers[server] = { ...servers[server], ...value };
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    // Write a private temp file, then rename it: never half a file, never readable by others.
    const temp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, this.file);
  }
}
