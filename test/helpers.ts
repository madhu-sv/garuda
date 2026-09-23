import { z } from "zod";
import type { Tool } from "../src/tools/types.js";

/** A test tool that returns its input text in upper case. */
export function upperTool(calls: string[] = []): Tool<{ text: string }> {
  return {
    name: "upper",
    description: "Return the text in upper case.",
    inputSchema: z.object({ text: z.string() }),
    readOnly: true,
    async run({ text }) {
      calls.push(text);
      return text.toUpperCase();
    },
  };
}

/** A test tool that always throws. */
export const failTool: Tool<Record<string, never>> = {
  name: "fail",
  description: "Always fails.",
  inputSchema: z.object({}),
  readOnly: true,
  async run() {
    throw new Error("disk on fire");
  },
};
