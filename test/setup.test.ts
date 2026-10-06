import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type Choice, type SetupIO, setupCommand } from "../src/cli/setupCommand.js";
import { CREDENTIALS_FILE, maskKey, readCredentials } from "../src/model/credentials.js";
import { loadModelsConfig } from "../src/model/providers.js";

// Every test gets its own home folder: the user's ~/.garuda is never read or written, and no test
// reaches the network (a fake fetch answers).
const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-setup-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let homes = 0;
const newHome = () => {
  const dir = join(base, `home-${++homes}`);
  mkdirSync(dir);
  return dir;
};

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-4f2c";

/** Scripted answers, in order. Each question checks that it gets the kind of answer it expects. */
function scripted(answers: unknown[], interactive = true) {
  const asked: string[] = [];
  const printed: string[] = [];
  const next = (kind: string, message: string) => {
    asked.push(`${kind}: ${message}`);
    if (answers.length === 0) throw new Error(`No answer left for ${kind}: ${message}`);
    return answers.shift();
  };
  const io: SetupIO = {
    interactive,
    select: async <T>(message: string, choices: Choice<T>[]) => {
      const answer = next("select", message);
      const found = choices.find((c) => c.value === answer);
      if (found === undefined) throw new Error(`"${String(answer)}" is not a choice of ${message}`);
      return found.value;
    },
    input: async (message) => String(next("input", message)),
    secret: async (message) => String(next("secret", message)),
    confirm: async (message) => Boolean(next("confirm", message)),
    print: (text) => printed.push(text),
  };
  return { io, asked, printed, left: answers };
}

interface Seen {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(status: number | Error, body: unknown = { data: [] }) {
  const seen: Seen[] = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    if (status instanceof Error) throw status;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetcher, seen };
}

describe("garuda setup (0.16)", () => {
  it("Claude: stores the default model and the key (0600), checks the key at Anthropic", async () => {
    const home = newHome();
    const { io, printed, left } = scripted([
      "anthropic",
      "claude-sonnet-5",
      KEY,
      true, // check now
    ]);
    const { fetcher, seen } = fakeFetch(200);
    expect(await setupCommand({}, { io, home, env: {}, fetch: fetcher })).toBe(0);
    expect(left).toEqual([]);

    const { config } = await loadModelsConfig(home);
    expect(config.default).toBe("claude-sonnet-5");
    expect(await readCredentials(home)).toEqual({ keys: { ANTHROPIC_API_KEY: KEY } });
    expect(statSync(join(home, CREDENTIALS_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".garuda")).mode & 0o777).toBe(0o700);

    // One free request, to Anthropic's own API, with the key.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.anthropic.com/v1/models?limit=1");
    expect(seen[0]?.headers["x-api-key"]).toBe(KEY);
    // The summary masks the key.
    const out = printed.join("\n");
    expect(out).not.toContain(KEY);
    expect(out).toContain(maskKey(KEY));
    expect(out).toContain("Model: claude-sonnet-5");
  });

  it("keeps the rest of models.json and the other stored keys", async () => {
    const home = newHome();
    mkdirSync(join(home, ".garuda"), { mode: 0o700 });
    const models = {
      providers: {
        lab: {
          type: "openai-compatible",
          baseUrl: "https://llm.example.com/v1",
          apiKeyEnv: "LAB_KEY",
        },
      },
      models: { "lab/coder": { contextWindow: 65536 } },
    };
    writeFileSync(join(home, ".garuda", "models.json"), JSON.stringify(models));
    writeFileSync(
      join(home, CREDENTIALS_FILE),
      JSON.stringify({ OTHER_KEY: "other-key-12345678" }),
      {
        mode: 0o600,
      },
    );
    const { io } = scripted(["lab", "coder", "lab-key-abcdefghijklmnop", true]);
    const { fetcher, seen } = fakeFetch(200);
    expect(await setupCommand({}, { io, home, env: {}, fetch: fetcher })).toBe(0);

    const { config } = await loadModelsConfig(home);
    expect(config).toMatchObject({ ...models, default: "lab/coder" });
    expect((await readCredentials(home)).keys).toEqual({
      OTHER_KEY: "other-key-12345678",
      LAB_KEY: "lab-key-abcdefghijklmnop",
    });
    // The check goes to the provider's own base URL, with the key as a bearer token.
    expect(seen[0]?.url).toBe("https://llm.example.com/v1/models");
    expect(seen[0]?.headers.authorization).toBe("Bearer lab-key-abcdefghijklmnop");
  });

  it("a refused key: enter it again, then the new key is stored", async () => {
    const home = newHome();
    let calls = 0;
    const fetcher = (async () =>
      new Response("{}", { status: ++calls === 1 ? 401 : 200 })) as typeof fetch;
    const { io, printed } = scripted([
      "anthropic",
      "claude-sonnet-5",
      "sk-ant-wrong-key-000000000000000000",
      true,
      "again",
      KEY,
    ]);
    expect(await setupCommand({}, { io, home, env: {}, fetch: fetcher })).toBe(0);
    expect(printed.join("\n")).toContain("refused the key (HTTP 401)");
    expect((await readCredentials(home)).keys).toEqual({ ANTHROPIC_API_KEY: KEY });
  });

  it("stop after a failed check: nothing is written", async () => {
    const home = newHome();
    const { fetcher } = fakeFetch(new TypeError("fetch failed"));
    const { io, printed } = scripted(["anthropic", "claude-sonnet-5", KEY, true, "stop"]);
    expect(await setupCommand({}, { io, home, env: {}, fetch: fetcher })).toBe(1);
    expect(printed.join("\n")).toContain("could not reach api.anthropic.com");
    expect(existsSync(join(home, ".garuda"))).toBe(false);
  });

  it("a key in the environment wins: setup stores the model and no key", async () => {
    const home = newHome();
    const { io, asked, printed } = scripted(["anthropic", "claude-sonnet-5", false]);
    const env = { ANTHROPIC_API_KEY: KEY };
    expect(await setupCommand({}, { io, home, env, fetch: fakeFetch(200).fetcher })).toBe(0);
    expect(asked.some((q) => q.startsWith("secret"))).toBe(false);
    expect(existsSync(join(home, CREDENTIALS_FILE))).toBe(false);
    expect((await loadModelsConfig(home)).config.default).toBe("claude-sonnet-5");
    expect(printed.join("\n")).toContain("from your environment");
    expect(printed.join("\n")).not.toContain(KEY);
  });

  it("a local server: its models are listed, no key is asked", async () => {
    const home = newHome();
    const { fetcher, seen } = fakeFetch(200, {
      data: [{ id: "qwen3-coder:30b" }, { id: "bad name" }],
    });
    const choices: string[][] = [];
    const { io, asked } = scripted(["ollama", "qwen3-coder:30b"]);
    const select = io.select;
    io.select = async (message, list) => {
      choices.push(list.map((c) => String(c.value)));
      return select(message, list);
    };
    expect(await setupCommand({}, { io, home, env: {}, fetch: fetcher })).toBe(0);
    expect(choices[1]).toEqual(["qwen3-coder:30b", "another model"]);
    expect(asked.some((q) => q.startsWith("secret"))).toBe(false);
    expect(seen.every((s) => s.url.startsWith("http://localhost:11434/v1/"))).toBe(true);
    expect((await loadModelsConfig(home)).config.default).toBe("ollama/qwen3-coder:30b");
  });

  it("with no terminal: a message, no question, nothing written", async () => {
    const home = newHome();
    const { io, asked, printed } = scripted([], false);
    expect(await setupCommand({}, { io, home, env: {}, fetch: fakeFetch(200).fetcher })).toBe(1);
    expect(asked).toEqual([]);
    expect(printed.join("\n")).toContain("needs a terminal");
    expect(existsSync(join(home, ".garuda"))).toBe(false);
  });

  it("never writes over a credentials file that Garuda would not read", async () => {
    const home = newHome();
    mkdirSync(join(home, ".garuda"), { mode: 0o700 });
    const target = join(base, `elsewhere-${homes}.json`);
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, join(home, CREDENTIALS_FILE));
    const { io, asked } = scripted([]);
    expect(await setupCommand({}, { io, home, env: {}, fetch: fakeFetch(200).fetcher })).toBe(1);
    expect(asked).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("{}");
  });

  it("Ctrl-C: exit code 130 and nothing written", async () => {
    const home = newHome();
    const { io } = scripted([]);
    io.select = async () => {
      throw Object.assign(new Error("User force closed the prompt"), { name: "ExitPromptError" });
    };
    expect(await setupCommand({}, { io, home, env: {}, fetch: fakeFetch(200).fetcher })).toBe(130);
    expect(existsSync(join(home, ".garuda"))).toBe(false);
  });
});

describe("garuda setup --show and --forget (0.16)", () => {
  const stored = (keys: Record<string, string>) => {
    const home = newHome();
    mkdirSync(join(home, ".garuda"), { mode: 0o700 });
    writeFileSync(join(home, CREDENTIALS_FILE), JSON.stringify(keys));
    chmodSync(join(home, CREDENTIALS_FILE), 0o600);
    writeFileSync(
      join(home, ".garuda", "models.json"),
      JSON.stringify({ default: "claude-sonnet-5" }),
    );
    return home;
  };

  it("--show: the model and where each key comes from, masked; works with no terminal", async () => {
    const home = stored({ ANTHROPIC_API_KEY: KEY });
    const { io, printed } = scripted([], false);
    const env = { OPENROUTER_API_KEY: "sk-or-v1-0123456789abcdef0123456789abcdef" };
    expect(await setupCommand({ show: true }, { io, home, env })).toBe(0);
    const out = printed.join("\n");
    expect(out).toContain("Model: claude-sonnet-5");
    expect(out).toContain(`ANTHROPIC_API_KEY: ${maskKey(KEY)} in`);
    expect(out).toContain("OPENROUTER_API_KEY: sk-or-…cdef from the environment");
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(env.OPENROUTER_API_KEY);
  });

  it("--forget <name>: asks, then removes only that key", async () => {
    const home = stored({ ANTHROPIC_API_KEY: KEY, LAB_KEY: "lab-key-abcdefghijklmnop" });
    const { io, asked } = scripted([true]);
    expect(await setupCommand({ forget: "LAB_KEY" }, { io, home, env: {} })).toBe(0);
    expect(asked).toHaveLength(1);
    expect((await readCredentials(home)).keys).toEqual({ ANTHROPIC_API_KEY: KEY });
  });

  it("--forget: 'no' keeps everything; 'yes' removes the file", async () => {
    const home = stored({ ANTHROPIC_API_KEY: KEY });
    expect(await setupCommand({ forget: true }, { io: scripted([false]).io, home, env: {} })).toBe(
      0,
    );
    expect((await readCredentials(home)).keys).toEqual({ ANTHROPIC_API_KEY: KEY });
    expect(await setupCommand({ forget: true }, { io: scripted([true]).io, home, env: {} })).toBe(
      0,
    );
    expect(existsSync(join(home, CREDENTIALS_FILE))).toBe(false);
  });
});

describe("maskKey", () => {
  it("never shows more than the start and the last four characters; short keys show less", () => {
    expect(maskKey(KEY)).toBe("sk-ant-…4f2c");
    expect(maskKey("abcdefghijklmnopqrstuvwxyz012345")).toBe("abc…2345");
    expect(maskKey("abcdefghijklmnopqrst")).toBe("…qrst");
    expect(maskKey("short-key")).toBe("…");
  });
});
