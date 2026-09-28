import type { ModelInfo } from "./pricing.js";
import { EFFORTS, type Effort, type Message, type ThinkingRequest } from "./types.js";

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

/** The user's /thinking choice (0.9). Absent fields: the model's default. */
export interface ThinkingChoice {
  /** Adaptive thinking on or off, for models where it is optional. */
  enabled?: boolean;
  effort?: Effort;
  /** Readable thinking (true) or empty thinking (false). */
  show?: boolean;
}

export type ThinkingCaps = NonNullable<ModelInfo["thinking"]>;

/** The request fields for a choice on a model (0.9). Undefined: send nothing, as before 0.9. */
export function thinkingRequest(
  choice: ThinkingChoice,
  caps: ThinkingCaps | undefined,
): ThinkingRequest | undefined {
  if (caps === undefined) return undefined;
  const request: ThinkingRequest = {};
  if (choice.effort !== undefined && caps.efforts.includes(choice.effort)) {
    request.effort = choice.effort;
  }
  // On an optional model, a display without adaptive thinking would turn thinking on.
  const thinks = caps.mode === "always" || choice.enabled === true;
  if (caps.mode === "optional" && choice.enabled === true) request.adaptive = true;
  if (thinks && choice.show !== undefined) request.display = choice.show ? "summarized" : "omitted";
  return Object.keys(request).length === 0 ? undefined : request;
}

/** The result of `/thinking <word>`: the new choice, or why not. */
export type ThinkingChange =
  | { ok: true; choice: ThinkingChoice; text: string }
  | { ok: false; text: string };

export const THINKING_WORDS = ["on", "off", "show", "hide", "default", ...EFFORTS] as const;

/** Apply one /thinking word to a choice for a model (0.9). Pure. */
export function changeThinking(
  choice: ThinkingChoice,
  word: string,
  caps: ThinkingCaps | undefined,
  modelId: string,
): ThinkingChange {
  if (caps === undefined) {
    return {
      ok: false,
      text: `${modelId} does not offer /thinking. It works with Claude Opus 4.6 and later and Sonnet 4.6 and later.`,
    };
  }
  const next: ThinkingChoice = { ...choice };
  if (word === "on" || word === "off") {
    if (caps.mode === "always") {
      return word === "on"
        ? { ok: true, choice: next, text: `${modelId} always thinks.` }
        : {
            ok: false,
            text: `${modelId} always thinks: the API does not let it stop. /thinking low makes it think less.`,
          };
    }
    next.enabled = word === "on";
  } else if (word === "show" || word === "hide") {
    next.show = word === "show";
  } else if (word === "default") {
    delete next.effort;
  } else if ((EFFORTS as readonly string[]).includes(word)) {
    const effort = word as Effort;
    if (!caps.efforts.includes(effort)) {
      return {
        ok: false,
        text: `${modelId} has no "${effort}" effort. Use one of: ${caps.efforts.join(", ")}.`,
      };
    }
    next.effort = effort;
  } else {
    return {
      ok: false,
      text: "Use: /thinking, or /thinking on|off, low|medium|high|xhigh|max|default, show|hide.",
    };
  }
  return { ok: true, choice: next, text: thinkingText(next, caps, modelId) };
}

/** The state line for /thinking (0.9). */
export function thinkingText(
  choice: ThinkingChoice,
  caps: ThinkingCaps | undefined,
  modelId: string,
): string {
  if (caps === undefined) return `${modelId} does not offer /thinking.`;
  const on = caps.mode === "always" ? "always on" : choice.enabled === true ? "on" : "off";
  const effort = choice.effort ?? "the model's default";
  const shown =
    choice.show === true
      ? "shown (dimmed; Ctrl-O shows all)"
      : choice.show === false
        ? "hidden"
        : "the model's default";
  return `Thinking for ${modelId}: ${on} · effort ${effort} · text ${shown}.`;
}

/** The part of a choice that another model can use (0.9, /models). */
export function fitThinking(
  choice: ThinkingChoice,
  caps: ThinkingCaps | undefined,
): { choice: ThinkingChoice; dropped: string[] } {
  const dropped: string[] = [];
  const next: ThinkingChoice = { ...choice };
  if (caps === undefined) {
    return {
      choice: {},
      dropped: Object.keys(choice).length === 0 ? [] : ["the /thinking choice"],
    };
  }
  if (next.effort !== undefined && !caps.efforts.includes(next.effort)) {
    dropped.push(`effort ${next.effort}`);
    delete next.effort;
  }
  return { choice: next, dropped };
}
