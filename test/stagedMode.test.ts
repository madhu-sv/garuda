import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { FakeModelClient, reply, text, toolUse } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { parseSettings } from "../src/permissions/settings.js";
import type { ApprovalRequest } from "../src/permissions/types.js";
import { findOsSandbox } from "../src/sandbox/index.js";
import { FileSessionStore } from "../src/session/store.js";
import { StagingError } from "../src/staging/copy.js";

/**
 * Staged commands end to end (0.17, review T5): a real OS sandbox, a fake model that calls bash.
 * Temporary homes only: nothing in the user's ~/.garuda.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-staged-mode-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let count = 0;

function project() {
  const dir = join(base, `m${count++}`);
  const root = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(root, ".gitignore"), "build/\n.garuda/\n");
  return { root, home };
}

async function session(
  root: string,
  home: string,
  commands: string[],
  answer: (request: ApprovalRequest) => "once" | "deny",
  mode: "staged" | "direct" = "staged",
  extra: Record<string, unknown> = {},
) {
  const model = new FakeModelClient([
    ...commands.map((command, i) => reply([toolUse("bash", { command, ...extra }, `b${i}`)])),
    reply([text("done")]),
  ]);
  const approver = new AutoApprover(answer);
  const runtime = await Runtime.create({
    root,
    modelId: "fake",
    model: async () => model,
    approver,
    store: new FileSessionStore(root),
    settings: parseSettings({ commands: { mode } }),
    mcp: false,
    hooks: false,
    profiles: [],
    undo: { home },
    staging: { home },
  });
  await runtime.runTurn("go", new AbortController().signal);
  const results = (runtime.session?.messages ?? [])
    .flatMap((m) => m.content)
    .filter((b) => b.type === "tool_result")
    .map((b) => (b.type === "tool_result" ? String(b.content) : ""));
  return { runtime, approver, results };
}

const read = (path: string) => readFileSync(path, "utf8");
const found = findOsSandbox();

describe.runIf("executor" in found)("staged commands in the OS sandbox", () => {
  it("discard: the project does not change; the model gets the note (control: direct mode changes it)", async () => {
    const { root, home } = project();
    // Portable on macOS and Linux (BSD sed -i needs a suffix argument; GNU sed does not).
    const write = "printf 'export const a = 99;\\n' > src/a.ts";
    const { runtime, approver, results } = await session(root, home, [write], () => "deny");
    expect(read(join(root, "src/a.ts"))).toBe("export const a = 1;\n");
    const asked = approver.requests.find((r) => r.title === "The command changed files");
    expect(asked?.preview).toContain("modified src/a.ts");
    expect(asked?.preview).toContain("+export const a = 99;");
    expect(results.join("\n")).toContain("the user discarded the command's changes");
    await runtime.close();

    const direct = project();
    const control = await session(direct.root, direct.home, [write], () => "deny", "direct");
    expect(read(join(direct.root, "src/a.ts"))).toBe("export const a = 99;\n");
    await control.runtime.close();
  });

  it("apply: the project gets the change; /undo restores it", async () => {
    const { root, home } = project();
    const { runtime, results } = await session(
      root,
      home,
      ["printf 'export const a = 99;\\n' > src/a.ts && rm src/b.ts && echo new > src/c.ts"],
      () => "once",
    );
    expect(read(join(root, "src/a.ts"))).toBe("export const a = 99;\n");
    expect(existsSync(join(root, "src/b.ts"))).toBe(false);
    expect(read(join(root, "src/c.ts"))).toBe("new\n");
    expect(results.join("\n")).toContain(
      "the user applied the command's changes to the project (3 files)",
    );
    const undone = await runtime.undo(new AbortController().signal);
    expect(undone).toBeDefined();
    expect(read(join(root, "src/a.ts"))).toBe("export const a = 1;\n");
    expect(read(join(root, "src/b.ts"))).toBe("export const b = 2;\n");
    expect(existsSync(join(root, "src/c.ts"))).toBe(false);
    await runtime.close();
  });

  // Linux mounts the copy at the project's path: the write goes to the copy and asks. macOS runs
  // the command at the copy's path with the project read-only: the write fails (decision Q3).
  it("a write to the project's absolute path never reaches the project", async () => {
    const { root, home } = project();
    const { runtime, approver, results } = await session(
      root,
      home,
      [`echo changed > ${root}/src/a.ts`],
      () => "deny",
    );
    expect(read(join(root, "src/a.ts"))).toBe("export const a = 1;\n");
    const asked = approver.requests.some((r) => r.title === "The command changed files");
    if (process.platform === "darwin") {
      expect(asked).toBe(false);
      expect(results[0]).toMatch(/Operation not permitted|Read-only/);
    } else {
      expect(asked).toBe(true);
    }
    await runtime.close();
  });

  it("no change: no question; ignored build output stays in the copy and the next command sees it", async () => {
    const { root, home } = project();
    const { runtime, approver, results } = await session(
      root,
      home,
      [
        "mkdir -p build && echo built > build/out.txt",
        "cat build/out.txt",
        "git --version || true",
      ],
      () => "once",
    );
    expect(approver.requests.filter((r) => r.title === "The command changed files")).toEqual([]);
    expect(results[1]).toContain("built");
    expect(existsSync(join(root, "build"))).toBe(false);
    await runtime.close();
  });

  it("outside_sandbox is not staged: it asks first, as before, and writes the project", async () => {
    const { root, home } = project();
    const { runtime, approver } = await session(
      root,
      home,
      ["printf 'export const a = 7;\\n' > src/a.ts"],
      () => "once",
      "staged",
      { outside_sandbox: true },
    );
    expect(read(join(root, "src/a.ts"))).toBe("export const a = 7;\n");
    expect(approver.requests.some((r) => r.target.kind === "command")).toBe(true);
    expect(approver.requests.some((r) => r.title === "The command changed files")).toBe(false);
    await runtime.close();
  });

  it("the copy is removed at the end of the session", async () => {
    const { root, home } = project();
    const { runtime } = await session(root, home, ["true"], () => "once");
    const staging = join(home, ".garuda", "staging");
    expect(readdirSync(staging).filter((n) => !n.startsWith("."))).not.toEqual([]);
    await runtime.close();
    expect(readdirSync(staging).filter((n) => !n.startsWith("."))).toEqual([]);
  });
});

describe("a staged session that cannot set up staging", () => {
  it("does not start; no command runs in direct mode (control: a direct session starts)", async () => {
    const { root, home } = project();
    const create = (mode: "staged" | "direct") =>
      Runtime.create({
        root,
        modelId: "fake",
        model: async () => new FakeModelClient([]),
        approver: new AutoApprover("once"),
        store: new FileSessionStore(root),
        settings: parseSettings({ executor: "host", commands: { mode } }),
        mcp: false,
        hooks: false,
        profiles: [],
        staging: { home },
      });
    await expect(create("staged")).rejects.toThrow(StagingError);
    await expect(create("staged")).rejects.toThrow(/need the OS sandbox/);
    const direct = await create("direct");
    await direct.close();
  });
});
