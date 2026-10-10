import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CREDENTIALS_FILE, readCredentials } from "../src/model/credentials.js";
import {
  chooseModel,
  keepProviderKeys,
  loadModelsConfig,
  providerKeySource,
  resolveModel,
} from "../src/model/providers.js";
import { sandboxPaths } from "../src/permissions/sandboxPaths.js";
import { Redactor } from "../src/session/redact.js";

// Every test gets its own home folder: the user's ~/.garuda is never read or written.
const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-credentials-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let homes = 0;

function home(content?: string, mode = 0o600): string {
  const dir = join(base, `home-${++homes}`);
  mkdirSync(join(dir, ".garuda"), { recursive: true, mode: 0o700 });
  if (content !== undefined) {
    writeFileSync(join(dir, CREDENTIALS_FILE), content, { mode });
    chmodSync(join(dir, CREDENTIALS_FILE), mode);
  }
  return dir;
}

/** A key name that no other test (and no real environment) uses. */
const keyName = () => `GARUDA_TEST_${Math.random().toString(36).slice(2).toUpperCase()}`;

describe("reading ~/.garuda/credentials (0.16)", () => {
  it("no file: no keys and no warning", async () => {
    expect(await readCredentials(home())).toEqual({ keys: {} });
  });

  it("reads a private file of key names to keys", async () => {
    const h = home(JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-stored-1" }));
    expect(await readCredentials(h)).toEqual({ keys: { ANTHROPIC_API_KEY: "sk-ant-stored-1" } });
  });

  it("ignores a file that other users can read, and says how to fix it", async () => {
    for (const mode of [0o640, 0o604]) {
      const h = home(JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-loose-1" }), mode);
      const r = await readCredentials(h);
      expect(r.keys).toEqual({});
      expect(r.warning).toContain("chmod 600");
      expect(r.warning).not.toContain("sk-ant-loose-1");
    }
  });

  it("ignores a symbolic link, also to a private file", async () => {
    const h = home();
    const target = join(base, `target-${homes}.json`);
    writeFileSync(target, JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-link-1" }), { mode: 0o600 });
    symlinkSync(target, join(h, CREDENTIALS_FILE));
    const r = await readCredentials(h);
    expect(r.keys).toEqual({});
    expect(r.warning).toContain("symbolic link");
  });

  it("ignores a folder in the file's place", async () => {
    const h = home();
    mkdirSync(join(h, CREDENTIALS_FILE), { mode: 0o700 });
    const r = await readCredentials(h);
    expect(r.keys).toEqual({});
    expect(r.warning).toContain("not a regular file");
  });

  it.runIf(process.getuid?.() === 0)("ignores a file that another user owns", async (ctx) => {
    const h = home(JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-other-1" }));
    try {
      chownSync(join(h, CREDENTIALS_FILE), 12345, 12345);
    } catch (error) {
      // Some containers run as root but cannot change an owner (review of 0.16.1).
      ctx.skip(`this file system cannot change owners (${(error as NodeJS.ErrnoException).code})`);
    }
    const r = await readCredentials(h);
    expect(r.keys).toEqual({});
    expect(r.warning).toContain("not owned by you");
  });

  it("ignores invalid JSON and never shows the file's text", async () => {
    const r = await readCredentials(home('{"ANTHROPIC_API_KEY": "sk-ant-broken-1'));
    expect(r.keys).toEqual({});
    expect(r.warning).toContain("not valid JSON");
    expect(r.warning).not.toContain("sk-ant-broken-1");
  });

  it("ignores a file of the wrong shape", async () => {
    for (const content of ["[]", '{"KEY": 5}', '{"bad name": "x"}', '{"KEY": ""}']) {
      const r = await readCredentials(home(content));
      expect(r.keys).toEqual({});
      expect(r.warning).toContain("not valid");
    }
  });
});

describe("stored keys at startup (0.16)", () => {
  it("fill a key that no variable sets; the key never enters process.env", async () => {
    const name = keyName();
    const h = home(JSON.stringify({ [name]: "sk-stored-value-1" }));
    expect(await keepProviderKeys([name], h)).toBeUndefined();
    expect(process.env[name]).toBeUndefined();
    expect(providerKeySource(name)).toBe("file");
    const model = resolveModel("box/m", {
      providers: { box: { type: "anthropic", apiKeyEnv: name } },
      models: {},
    });
    const client = (await model.create({})) as unknown as { client?: { apiKey?: string } };
    expect(client.client?.apiKey).toBe("sk-stored-value-1");
  });

  it("an environment variable wins over the stored key", async () => {
    const name = keyName();
    const h = home(JSON.stringify({ [name]: "sk-stored-value-2" }));
    process.env[name] = "sk-env-value-2";
    try {
      await keepProviderKeys([name], h);
      expect(process.env[name]).toBeUndefined();
      expect(providerKeySource(name)).toBe("environment");
      const model = resolveModel("box/m", {
        providers: { box: { type: "anthropic", apiKeyEnv: name } },
        models: {},
      });
      const client = (await model.create({})) as unknown as { client?: { apiKey?: string } };
      expect(client.client?.apiKey).toBe("sk-env-value-2");
    } finally {
      delete process.env[name];
    }
  });

  it("the redactor removes a stored key, whatever its name", async () => {
    // "BOXAUTH" does not look secret by its name; the redactor knows it because Garuda kept it.
    const name = `BOXAUTH${Math.random().toString(36).slice(2).toUpperCase()}`;
    await keepProviderKeys([name], home(JSON.stringify({ [name]: "box-stored-9f8e7d6c" })));
    expect(new Redactor().text("key: box-stored-9f8e7d6c")).not.toContain("box-stored-9f8e7d6c");
  });

  it("an ignored file gives its warning and no key", async () => {
    const name = keyName();
    const warning = await keepProviderKeys(
      [name],
      home(JSON.stringify({ [name]: "sk-stored-value-3" }), 0o644),
    );
    expect(warning).toContain("chmod 600");
    expect(providerKeySource(name)).toBeUndefined();
  });
});

describe("the default model in ~/.garuda/models.json (0.16)", () => {
  it("is used only when nothing else names a model", async () => {
    const h = home();
    writeFileSync(join(h, ".garuda", "models.json"), JSON.stringify({ default: "ollama/qwen3" }));
    const { config, problem } = await loadModelsConfig(h);
    expect(problem).toBeUndefined();
    expect(chooseModel(config)).toBe("ollama/qwen3");
    expect(chooseModel(config, undefined, "", undefined)).toBe("ollama/qwen3");
    expect(chooseModel(config, "claude-sonnet-5", "ollama/x")).toBe("claude-sonnet-5");
    expect(chooseModel(config, undefined, "env/model")).toBe("env/model");
    expect(chooseModel({})).toBeUndefined();
  });
});

describe("the sandbox list (0.16)", () => {
  it("hides ~/.garuda/credentials from commands; the rest of ~/.garuda stays readable", () => {
    const deny = sandboxPaths("/repo", {}, "/home/u").denyReadPaths;
    expect(deny).toContain("/home/u/.garuda/credentials");
    expect(deny).not.toContain("/home/u/.garuda");
  });
});
