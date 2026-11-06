import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicClient, clientOptions } from "../src/model/anthropic.js";
import { sandboxPaths } from "../src/permissions/sandboxPaths.js";

/**
 * 0.18.3: the Anthropic SDK 1.x uses API version 2026-10-21. It sends the key as
 * `Authorization: Bearer`, not `X-Api-Key`, and that version refuses `temperature`, `top_p` and
 * `top_k` with a 400 error. These tests fix what Garuda's requests look like.
 */

describe("requests with the Anthropic SDK 1.x", () => {
  it("send API version 2026-10-21, the key as a bearer token only, and no sampling parameters", async () => {
    const seen: { headers: Headers; body: Record<string, unknown> }[] = [];
    const capture = (async (_url: unknown, init?: RequestInit) => {
      seen.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      // A 400 is not retried: one request, then the error.
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "test" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const sdk = new Anthropic({ ...clientOptions("sk-ant-test"), fetch: capture });
    const client = new AnthropicClient({ model: "claude-haiku-5-5", client: sdk });
    const events: unknown[] = [];
    await expect(
      (async () => {
        for await (const e of client.stream({
          system: "s",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          tools: [],
          maxTokens: 64,
        })) {
          events.push(e);
        }
      })(),
    ).rejects.toThrow();
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request?.headers.get("anthropic-version")).toBe("2026-10-21");
    expect(request?.headers.get("authorization")).toBe("Bearer sk-ant-test");
    expect(request?.headers.get("x-api-key")).toBeNull();
    for (const name of ["temperature", "top_p", "top_k"])
      expect(request?.body).not.toHaveProperty(name);
  });
});

describe("the SDK's stored keys", () => {
  it("are unreadable for sandboxed commands, like the other credentials", () => {
    const home = join(realpathSync(tmpdir()), "fake-home");
    const deny = sandboxPaths(join(home, "project"), {}, home).denyReadPaths;
    // The `ant` CLI writes them, and the SDK 1.x reads them when it gets no key.
    expect(deny).toContain(join(home, ".config", "anthropic", "credentials"));
    // The profile settings (base URL, auth mode) stay readable.
    expect(deny).not.toContain(join(home, ".config", "anthropic"));
  });
});
