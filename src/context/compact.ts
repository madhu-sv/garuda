import { hasServerBlocks, serverPairText, withoutServerBlocks } from "../model/serverTools.js";
import type {
  ContentBlock,
  Message,
  ModelClient,
  ModelResponse,
  ToolResultBlock,
} from "../model/types.js";
import type { Session } from "../session/session.js";
import { addCost } from "../session/session.js";
import { compacted } from "../session/undo.js";

/**
 * Compaction (F23). When the context passes `threshold` of the window, compaction runs in two stages:
 *   1. trim:    cut long tool outputs in older turns. No model call.
 *   2. summary: if the estimate is still above `target`, the model summarises the older turns.
 * The most recent `keepSteps` assistant turns always stay in full.
 */

export interface CompactionOptions {
  contextWindow: number;
  /** Start compaction above this share of the window. */
  threshold?: number;
  /** Stop after stage 1 when the estimate is at or below this share. */
  target?: number;
  keepSteps?: number;
  /** Cost of the summary response, when the price is known. */
  costOf?: (response: ModelResponse) => number | undefined;
}

export interface CompactionResult {
  stage: "trim" | "summary";
  beforeTokens: number;
  afterTokens: number;
}

const COMPACTED_MARKER = "[Earlier turns of this session were compacted to save context.]";

export const COMPACTION_DEFAULTS = { threshold: 0.8, target: 0.6, keepSteps: 4 } as const;

/** Tool outputs longer than this, in older turns, are cut in stage 1. */
const TRIM_OVER_CHARS = 1_000;
const TRIM_KEEP_CHARS = 200;
/** Rough size of a token, for estimates between real counts. */
const CHARS_PER_TOKEN = 4;

export const SUMMARY_SYSTEM = [
  "You summarise a coding session between a user and a coding agent, so the agent can continue it.",
  "Keep: the user's requests (quote them), decisions, facts found in the code (paths, names, line numbers),",
  "changes made so far, commands and their results, open problems, and the next steps.",
  "Leave out: greetings, repeated tool output, and file contents that the agent can read again.",
  "Write short plain sentences and lists. Do not invent facts.",
].join("\n");

export async function compactIfNeeded(
  session: Session,
  model: ModelClient,
  options: CompactionOptions,
  signal: AbortSignal,
): Promise<CompactionResult | undefined> {
  const threshold = options.threshold ?? COMPACTION_DEFAULTS.threshold;
  const target = options.target ?? COMPACTION_DEFAULTS.target;
  const keepSteps = options.keepSteps ?? COMPACTION_DEFAULTS.keepSteps;
  const before = session.contextTokens;
  if (before <= options.contextWindow * threshold) return undefined;

  const split = splitIndex(session.messages, keepSteps);
  if (split <= 0) return undefined;

  // Stage 1: trim.
  const { messages: trimmed, savedChars } = trimOldToolOutputs(session.messages, split);
  const afterTrim = Math.max(0, before - Math.ceil(savedChars / CHARS_PER_TOKEN));
  if (savedChars > 0 && afterTrim <= options.contextWindow * target) {
    return apply(session, { stage: "trim", beforeTokens: before, afterTokens: afterTrim }, trimmed);
  }

  // Stage 2: summary of everything before the split.
  const older = trimmed.slice(0, split);
  const recent = trimmed.slice(split);
  const summary = await summarise(model, older, signal);
  const summaryText = summary.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const first = firstUserText(session.messages);
  const opening: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          COMPACTED_MARKER,
          first === undefined ? "" : `The user's first request was:\n${first}\n`,
          `Summary of the earlier turns:\n${summaryText}`,
        ]
          .filter((part) => part !== "")
          .join("\n"),
      },
    ],
  };
  const messages = [opening, ...recent];
  const costUsd = options.costOf?.(summary);
  addCost(session, summary.usage, costUsd);
  const afterTokens = Math.ceil(charCount(messages) / CHARS_PER_TOKEN);
  return apply(session, { stage: "summary", beforeTokens: before, afterTokens }, messages, {
    summary,
    costUsd,
  });
}

function apply(
  session: Session,
  result: CompactionResult,
  messages: Message[],
  extra: { summary?: ModelResponse; costUsd?: number | undefined } = {},
): CompactionResult {
  session.messages = messages;
  compacted(session.undo);
  session.files.forgetReads();
  session.contextTokens = result.afterTokens;
  session.journal?.write({
    type: "compaction",
    ...result,
    messages,
    ...(extra.summary === undefined ? {} : { summary: extra.summary }),
    ...(extra.costUsd === undefined ? {} : { costUsd: extra.costUsd }),
  });
  return result;
}

/**
 * Index of the first message to keep in full: the `keepSteps`-th assistant message from the end.
 * The kept part starts with an assistant message, so the summary (a user message) can go first
 * and every kept tool_use still has its tool_result.
 */
export function splitIndex(messages: readonly Message[], keepSteps: number): number {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant" && ++seen === keepSteps) return i;
  }
  return -1;
}

export function trimOldToolOutputs(
  messages: readonly Message[],
  end: number,
): { messages: Message[]; savedChars: number } {
  let savedChars = 0;
  const out = messages.map((message, index): Message => {
    // Old server searches (0.6): their encrypted results become a short text of titles and URLs.
    if (index < end && message.role === "assistant" && hasServerBlocks(message.content)) {
      const content = withoutServerBlocks(message.content);
      savedChars += Math.max(
        0,
        JSON.stringify(message.content).length - JSON.stringify(content).length,
      );
      return { ...message, content };
    }
    if (index >= end || message.role !== "user") return message;
    const content = message.content.map((block): ContentBlock => {
      if (block.type !== "tool_result" || block.content.length <= TRIM_OVER_CHARS) return block;
      const cut = cutResult(block);
      savedChars += block.content.length - cut.content.length;
      return cut;
    });
    return { ...message, content };
  });
  return { messages: out, savedChars };
}

function cutResult(block: ToolResultBlock): ToolResultBlock {
  const head = block.content.slice(0, TRIM_KEEP_CHARS);
  return {
    ...block,
    content: `${head}\n… [Old output cut to save context. It had ${block.content.length} characters. Run the tool again if you need it.]`,
  };
}

async function summarise(
  model: ModelClient,
  messages: readonly Message[],
  signal: AbortSignal,
): Promise<ModelResponse> {
  const request = {
    system: SUMMARY_SYSTEM,
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: `Summarise this part of the session.\n\n<session>\n${transcript(messages)}\n</session>`,
          },
        ],
      },
    ],
    tools: [],
    maxTokens: 4096,
  };
  let response: ModelResponse | undefined;
  for await (const event of model.stream(request, { signal })) {
    if (event.type === "response") response = event.response;
  }
  if (response === undefined) throw new Error("The model gave no summary.");
  return response;
}

/** The older turns as plain text for the summary request. Long tool outputs are cut. */
export function transcript(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "text") {
        lines.push(`${message.role === "user" ? "User" : "Agent"}: ${block.text}`);
      } else if (block.type === "tool_use") {
        lines.push(`Agent called ${block.name} ${JSON.stringify(block.input)}`);
      } else if (block.type === "server_tool_use") {
        lines.push(`Agent called ${block.name} (server) ${JSON.stringify(block.input)}`);
      } else if (block.type === "server_tool_result") {
        lines.push(serverPairText(undefined, block));
      } else {
        const text =
          block.content.length > 2_000 ? `${block.content.slice(0, 2_000)} …` : block.content;
        lines.push(`Result${block.isError ? " (error)" : ""}: ${text}`);
      }
    }
  }
  return lines.join("\n");
}

function firstUserText(messages: readonly Message[]): string | undefined {
  const first = messages[0];
  if (first?.role !== "user") return undefined;
  const text = first.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  // After an earlier compaction, the first message is the old summary. The new summary covers it.
  if (text === "" || text.startsWith(COMPACTED_MARKER)) return undefined;
  return text.length > 4_000 ? `${text.slice(0, 4_000)} …` : text;
}

function charCount(messages: readonly Message[]): number {
  let chars = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "tool_use" || block.type === "server_tool_use")
        chars += JSON.stringify(block.input).length + block.name.length;
      else if (block.type === "server_tool_result") chars += JSON.stringify(block.wire).length;
      else chars += block.content.length;
    }
  }
  return chars;
}
