import type { Message } from "./types.js";

/**
 * Thinking blocks (0.9). Claude's thinking must go back unchanged within a tool-use turn; across
 * turns the API allows leaving it out. Garuda leaves it out when it cannot send it back unchanged:
 * after a switch to another model (the signature belongs to the model that wrote it), and when
 * redaction changed a block on disk.
 */

/** The messages without thinking blocks. An assistant message with nothing else left goes too. */
export function withoutThinking(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (!message.content.some((b) => b.type === "thinking")) {
      out.push(message);
      continue;
    }
    const content = message.content.filter((b) => b.type !== "thinking");
    if (content.length > 0) out.push({ ...message, content });
  }
  return out;
}

/** True when any message holds a thinking block. */
export function hasThinking(messages: readonly Message[]): boolean {
  return messages.some((m) => m.content.some((b) => b.type === "thinking"));
}
