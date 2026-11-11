import { afterEach, describe, expect, it, vi } from "vitest";

/** 0.20.1: the terminal question starts on the request's default choice, as the chat does. */

const seen: { default?: unknown; choices: { value: string }[] }[] = [];
vi.mock("@inquirer/prompts", () => ({
  select: async (config: { default?: unknown; choices: { value: string }[] }) => {
    seen.push(config);
    return config.default ?? config.choices[0]?.value;
  },
}));

const { TerminalApprover } = await import("../src/cli/approver.js");

describe("the terminal approver", () => {
  const tty = process.stdin.isTTY;
  afterEach(() => {
    process.stdin.isTTY = tty;
    vi.restoreAllMocks();
  });

  it("gives Inquirer the default choice; Enter then answers it", async () => {
    process.stdin.isTTY = true;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const approver = new TerminalApprover();
    const base = {
      tool: "sandbox_read",
      target: { kind: "path" as const, path: "/h/x" },
      preview: "x",
      isolation: "os" as const,
      choices: ["session", "deny"] as const,
    };
    const signal = new AbortController().signal;
    expect(await approver.ask({ ...base, defaultChoice: "deny" }, signal)).toBe("deny");
    expect(seen[0]?.default).toBe("deny");
    // Without one, the first choice, as before.
    expect(await approver.ask(base, signal)).toBe("session");
    expect(seen[1]).not.toHaveProperty("default");
  });
});
