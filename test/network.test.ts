import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { networkConsent, networkHash, nodeBinary } from "../src/app/network.js";
import { Runtime } from "../src/app/runtime.js";
import { prepareJob } from "../src/cli/jobCommand.js";
import { runEvalTask } from "../src/evals/runner.js";
import type { EvalTask } from "../src/evals/types.js";
import { createJob } from "../src/jobs/create.js";
import { git } from "../src/jobs/git.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import type { ModelRequest } from "../src/model/types.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { ApprovalChoice, ApprovalRequest, Approver } from "../src/permissions/types.js";
import { HostExecutor } from "../src/sandbox/host.js";
import { findOsSandbox } from "../src/sandbox/index.js";
import { FileSessionStore } from "../src/session/store.js";

/** The network allowlist in the runtime, jobs and evals (0.13, W6). */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-network-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const dirs = () => {
  const home = join(base, `home${n}`);
  const root = join(base, `root${n++}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  return { home, root };
};

class Scripted implements Approver {
  readonly requests: ApprovalRequest[] = [];
  constructor(private readonly answers: ApprovalChoice[]) {}
  async ask(request: ApprovalRequest): Promise<ApprovalChoice> {
    this.requests.push(request);
    return this.answers.shift() ?? "deny";
  }
}

/** The text of the last tool result the model got. */
function lastResult(request: ModelRequest | undefined): string {
  const block = request?.messages.at(-1)?.content[0];
  if (block?.type !== "tool_result") throw new Error("expected a tool_result");
  return typeof block.content === "string" ? block.content : JSON.stringify(block.content);
}

describe("network allowlist: the parts (0.13)", () => {
  it("rejects a settings entry that is neither a preset nor a host", () => {
    expect(parseSettings({ network: { allow: ["npm", "api.example.com"] } }).network).toEqual({
      allow: ["npm", "api.example.com"],
    });
    expect(parseSettings({ network: { allow: [] } }).network).toBeUndefined();
    expect(() => parseSettings({ network: { allow: ["npmjs"] } })).toThrow(/network\.allow/);
  });

  it("hashes the list in any order and case; the consent shows each preset's hosts", () => {
    expect(networkHash(["npm", "Pypi"])).toBe(networkHash(["pypi", "npm", "npm"]));
    expect(networkHash(["npm"])).not.toBe(networkHash(["npm", "pypi"]));
    const consent = networkConsent(["npm", "x.dev"], "os", false);
    expect(consent.title).toBe("Open the network for commands?");
    expect(consent.preview).toContain("  npm: registry.npmjs.org, registry.yarnpkg.com");
    expect(consent.preview).toContain("  x.dev");
    expect(networkConsent(["npm"], "os", true).preview).toMatch(/changed since you allowed it/);
  });

  it("finds node for the bridge: this process, else the PATH", () => {
    expect(nodeBinary("/opt/node/bin/node", "")).toBe("/opt/node/bin/node");
    const dir = join(base, "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "node"), "");
    expect(nodeBinary("/usr/local/bin/garuda", `/nowhere:${dir}`)).toBe(join(dir, "node"));
    expect(nodeBinary("/usr/local/bin/garuda", "/nowhere")).toBeUndefined();
  });
});

const found = findOsSandbox();
const sandboxed = "executor" in found;
let curl = false;
try {
  curl = realpathSync("/usr/bin/curl") !== "";
} catch {
  curl = false;
}

describe.runIf(sandboxed && curl)("network allowlist in the runtime (0.13)", () => {
  const curlCode = (url: string) => `curl -sS --max-time 10 -o /dev/null -w "%{http_code}" ${url}`;

  async function turn(root: string, home: string, approver: Approver, command: string) {
    const model = new FakeModelClient([
      reply([toolUse("bash", { command }, "b1")]),
      reply([text("Done.")]),
    ]);
    const notices: string[] = [];
    const runtime = await Runtime.create({
      root,
      modelId: "claude-sonnet-5",
      model: async () => model,
      approver,
      store: new FileSessionStore(root),
      settings: parseSettings({ executor: "os", network: { allow: ["npm", "allowed.test"] } }),
      mcp: false,
      hooks: false,
      profiles: [],
      network: { home },
      onNotice: (t) => notices.push(t),
    });
    await runtime.runTurn("go", AbortSignal.timeout(30_000));
    const allowlist = runtime.networkAllowlist();
    await runtime.close();
    const prompt = JSON.stringify(model.requests[0]?.messages.at(-1)?.content ?? []);
    return { result: lastResult(model.requests[1]), notices, allowlist, prompt };
  }

  it("asks once for the project's list; an unlisted host asks; a denied host gets 403 and a hint", async () => {
    const { home, root } = dirs();
    const approver = new Scripted(["session", "deny"]);
    const first = await turn(root, home, approver, curlCode("http://other.test/"));
    expect(approver.requests.map((r) => r.title)).toEqual([
      "Open the network for commands?",
      "Let a command reach other.test?",
    ]);
    expect(first.notices).toContain(
      "Network for commands: npm, allowed.test, through Garuda's proxy. Other hosts ask.",
    );
    expect(first.allowlist).toEqual(["npm", "allowed.test"]);
    // The model learns which hosts work in the sandbox (live test: it went outside at once).
    expect(first.prompt).toContain("Commands in the sandbox can reach these hosts");
    expect(first.prompt).toContain("npm: registry.npmjs.org");
    expect(first.prompt).toContain("Do not use outside_sandbox for them");
    // Live test 2: for an unlisted host the model still went outside; the note covers it now.
    expect(first.prompt).toContain("For any other host, also run the command in the sandbox");
    expect(first.result).toContain("403");
    expect(first.result).toMatch(
      /Garuda's network allowlist blocked other\.test:80: The user denied/,
    );
    expect(first.result).toMatch(/network\.allow/);

    // The list is pinned: no question. A listed host is not asked; a wrong port is blocked.
    const again = new Scripted([]);
    const second = await turn(root, home, again, curlCode("http://allowed.test:8080/"));
    expect(again.requests).toEqual([]);
    // One notice per session, also when the list is pinned (live test showed it twice).
    expect(second.notices.filter((t) => t.startsWith("Network for commands"))).toHaveLength(1);
    expect(second.result).toMatch(/blocked allowed\.test:8080: only ports 80 and 443/);
  }, 60_000);

  it("a denied consent leaves commands with no network and no proxy", async () => {
    const { home, root } = dirs();
    const approver = new Scripted(["deny"]);
    const run = await turn(root, home, approver, curlCode("http://other.test/"));
    expect(approver.requests).toHaveLength(1);
    expect(run.notices).toContain(
      "Network for commands: off (you said no). Commands have no network.",
    );
    expect(run.allowlist).toEqual([]);
    expect(run.prompt).not.toContain("Commands in the sandbox can reach");
    expect(run.result).not.toContain("network allowlist blocked");
  }, 60_000);

  it("an eval with --network denies other hosts with no question", async () => {
    const task: EvalTask = {
      id: "net",
      title: "net",
      prompt: "go",
      files: { "a.txt": "a\n" },
      check: "true",
      solution: {},
    };
    let seen = "";
    const result = await runEvalTask(task, {
      modelId: "fake",
      network: ["npm"],
      model: () =>
        new FakeModelClient([
          // The eval deny rules block curl and wget: Python's urllib reads the proxy variables too.
          reply([
            toolUse(
              "bash",
              {
                command: `python3 -c "import urllib.request as u; u.urlopen('https://other.test/', timeout=10)"`,
              },
              "b1",
            ),
          ]),
          (request) => {
            seen = lastResult(request);
            return reply([text("Done.")]);
          },
        ]),
    });
    expect(result.passed).toBe(true);
    expect(seen).toMatch(/blocked other\.test:443: A deny rule blocks this call: network/);
  }, 60_000);
});

describe("network allowlist in jobs (0.13)", () => {
  class SandboxedHost extends HostExecutor {
    override readonly isolation = "os" as unknown as "none";
  }

  it("the job keeps the list approved in the chat, and its run uses that list", async () => {
    const { home, root } = dirs();
    writeFileSync(join(root, "a.txt"), "a\n");
    mkdirSync(join(root, ".garuda"), { recursive: true });
    // The project's list changed after the job was made: the job keeps its own.
    writeFileSync(
      join(root, ".garuda", "settings.json"),
      JSON.stringify({ network: { allow: ["github"] } }),
    );
    const host = new HostExecutor();
    const g = (...args: string[]) => git(host, root, args);
    await g("init", "-q");
    await g("config", "user.email", "dev@example.com");
    await g("config", "user.name", "Dev");
    await g("add", "-A");
    await g("commit", "-q", "-m", "start");
    const created = await createJob({
      root,
      executor: new SandboxedHost(),
      approver: new AutoApprover("once"),
      plan: { request: "Install lodash", plan: "1. npm install lodash.", sessionId: "s1" },
      modelId: "fake",
      home,
      network: ["npm"],
      signal: new AbortController().signal,
    });
    if (!created.ok) throw new Error(created.text);
    expect(created.job.network).toEqual(["npm"]);
    const quiet = { event: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const prepared = await prepareJob(root, created.job.id, undefined, quiet, host);
    if (typeof prepared === "number") throw new Error(`exit ${prepared}`);
    expect(prepared.settings.network).toEqual({ allow: ["npm"] });
  });
});
