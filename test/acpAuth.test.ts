import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  client as createClient,
  type InitializeResponse,
  methods,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { acpServer, SETUP_METHOD_ID, setupNeeded } from "../src/acp/server.js";
import { acpCommand, prepare, WINDOWS_MESSAGE } from "../src/cli/acpCommand.js";
import { setupCommand } from "../src/cli/setupCommand.js";
import { CREDENTIALS_FILE } from "../src/model/credentials.js";

/** ACP Terminal Auth and the per-session setup (0.16, docs/lld/setup.md). */

// Temporary home folders only: the user's ~/.garuda and policy files are never read.
const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-acp-auth-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let homes = 0;

/** The shell of the person who runs the tests may set these; each test starts without them. */
const SHELL_VARS = ["GARUDA_MODEL", "GARUDA_SUBAGENT_MODEL", "ANTHROPIC_AUTH_TOKEN"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const name of SHELL_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(() => {
  for (const name of SHELL_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

/** A home whose models.json has a provider with a key name that nothing else uses. */
function home(withDefault = true): { home: string; keyName: string } {
  const dir = join(base, `home-${++homes}`);
  mkdirSync(join(dir, ".garuda"), { recursive: true, mode: 0o700 });
  const keyName = `GARUDA_TEST_${Math.random().toString(36).slice(2).toUpperCase()}`;
  const models = {
    providers: {
      box: { type: "openai-compatible", baseUrl: "https://llm.example.com/v1", apiKeyEnv: keyName },
    },
    ...(withDefault ? { default: "box/coder" } : {}),
  };
  writeFileSync(join(dir, ".garuda", "models.json"), JSON.stringify(models));
  return { home: dir, keyName };
}

function storeKey(dir: string, keys: Record<string, string>) {
  writeFileSync(join(dir, CREDENTIALS_FILE), JSON.stringify(keys));
  chmodSync(join(dir, CREDENTIALS_FILE), 0o600);
}

const initialize = (auth: { terminal?: boolean } | undefined, terminalAuth = true) => {
  const server = acpServer({
    version: "t",
    ...(terminalAuth ? { terminalAuth: { args: ["setup"] } } : {}),
    createRuntime: () => Promise.reject(new Error("unused")),
  });
  return createClient({ name: "t" }).connectWith(
    server.app,
    (agent): Promise<InitializeResponse> =>
      agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: auth === undefined ? {} : { auth },
      }),
  );
};

describe("ACP Terminal Auth (0.16)", () => {
  it("offers `garuda acp setup` to an editor that declares auth.terminal", async () => {
    const response = await initialize({ terminal: true });
    expect(response.authMethods).toEqual([
      {
        type: "terminal",
        id: SETUP_METHOD_ID,
        name: "Set up Garuda",
        description: "Choose a model and enter its API key.",
        args: ["setup"],
      },
    ]);
  });

  it("offers nothing to an editor without the capability, or when the server has none", async () => {
    expect((await initialize(undefined)).authMethods).toEqual([]);
    expect((await initialize({ terminal: false })).authMethods).toEqual([]);
    expect((await initialize({ terminal: true }, false)).authMethods).toEqual([]);
  });

  it("session/new: a missing setup is 'auth required'; another problem is an internal error", async () => {
    const answers = [setupNeeded("Garuda has no model."), new Error("Team policy: broken")];
    const server = acpServer({
      version: "t",
      terminalAuth: { args: ["setup"] },
      createRuntime: () => Promise.reject(answers.shift()),
    });
    const root = join(base, "root");
    mkdirSync(root, { recursive: true });
    const errors = await createClient({ name: "t" }).connectWith(server.app, async (agent) => {
      const out: { code: number; message: string }[] = [];
      for (let i = 0; i < 2; i++) {
        await agent
          .request(methods.agent.session.new, { cwd: root, mcpServers: [] })
          .catch((e: { code: number; message: string }) =>
            out.push({ code: e.code, message: e.message }),
          );
      }
      return out;
    });
    expect(errors[0]).toEqual({
      code: -32000,
      message: "Authentication required: Garuda has no model.",
    });
    expect(errors[1]?.code).toBe(-32603);
  });
});

describe("the setup, read for each session (0.16)", () => {
  it("no model: setup needed", async () => {
    const r = await prepare({}, { home: home(false).home, managed: undefined });
    expect(r).toMatchObject({ setupNeeded: true });
    expect("problem" in r && r.problem).toContain("garuda setup");
  });

  it("no key for the model: setup needed, and the message names the key", async () => {
    const { home: dir, keyName } = home();
    const r = await prepare({}, { home: dir, managed: undefined });
    expect(r).toMatchObject({ setupNeeded: true });
    expect("problem" in r && r.problem).toContain(keyName);
  });

  it("after a setup, the next session works with no restart; after --forget, it needs setup again", async () => {
    const { home: dir, keyName } = home();
    expect(await prepare({}, { home: dir, managed: undefined })).toMatchObject({
      setupNeeded: true,
    });

    storeKey(dir, { [keyName]: "box-key-abcdefghijklmnop" });
    const ready = await prepare({}, { home: dir, managed: undefined });
    expect("resolved" in ready && ready.resolved.spec).toBe("box/coder");

    // `garuda setup --forget` removes the key; the next session reads the file again.
    const io = {
      interactive: true,
      select: async () => {
        throw new Error("no select");
      },
      input: async () => "",
      secret: async () => "",
      confirm: async () => true,
      print: () => {},
    };
    expect(await setupCommand({ forget: true }, { io, home: dir, env: {} })).toBe(0);
    expect(await prepare({}, { home: dir, managed: undefined })).toMatchObject({
      setupNeeded: true,
    });
  });

  it("native Windows: a plain message, not 'auth required' (a setup cannot help)", async () => {
    const { home: dir, keyName } = home();
    storeKey(dir, { [keyName]: "box-key-abcdefghijklmnop" });
    expect(await prepare({}, { home: dir, managed: undefined, platform: "win32" })).toEqual({
      problem: WINDOWS_MESSAGE,
      setupNeeded: false,
    });
  });

  it("`garuda acp <other>` is refused", async () => {
    const write = process.stderr.write;
    let said = "";
    process.stderr.write = ((chunk: string) => {
      said += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await acpCommand({ action: "login" })).toBe(1);
    } finally {
      process.stderr.write = write;
    }
    expect(said).toContain("garuda acp [setup]");
  });
});
