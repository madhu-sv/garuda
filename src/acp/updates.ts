import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import type { AgentEvent } from "../loop/events.js";
import { oneLine, viewOf } from "./toolCalls.js";

/** The editor, as the adapter needs it. The SDK's request context implements it. */
export interface AcpClient {
  notify(method: "session/update", params: SessionNotification): Promise<void>;
  request(
    method: "session/request_permission",
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse>;
}

/** The longest tool result text in an update, in characters. The model sees the whole result. */
export const RESULT_MAX_CHARS = 50_000;

/** A text block for tool call content. */
export function textContent(text: string): ToolCallContent {
  return { type: "content", content: { type: "text", text } };
}

/**
 * One ACP session's way to the editor. Updates go out in order (each waits for the one before),
 * and only while a prompt runs: the client of the running `session/prompt` is the channel. Notices
 * that come between prompts wait for the next prompt.
 */
export class SessionChannel {
  private client: AcpClient | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly waiting: string[] = [];

  constructor(readonly sessionId: string) {}

  /** The prompt starts: send to this client, and send the notices that waited. */
  open(client: AcpClient): void {
    this.client = client;
    for (const text of this.waiting.splice(0)) this.message(text);
  }

  /** The prompt ends: wait for every update, then stop sending. */
  async close(): Promise<void> {
    await this.chain;
    this.client = undefined;
  }

  get current(): AcpClient | undefined {
    return this.client;
  }

  update(update: SessionUpdate): void {
    const client = this.client;
    if (client === undefined) return;
    this.chain = this.chain
      .then(() => client.notify("session/update", { sessionId: this.sessionId, update }))
      // A lost update must not stop the turn; the editor's log has the error.
      .catch((error: unknown) => {
        process.stderr.write(`garuda acp: session/update failed: ${String(error)}\n`);
      });
  }

  /** Every update so far has gone out. */
  flush(): Promise<void> {
    return this.chain;
  }

  /** A line from Garuda (not the model), as message text. Kept for the next prompt if none runs. */
  notice(text: string): void {
    if (this.client === undefined) this.waiting.push(text);
    else this.message(text);
  }

  private message(text: string): void {
    this.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `\n\nGaruda: ${text}\n\n` },
    });
  }
}

/** The tool calls of a session that the editor knows, by id. */
export class KnownCalls {
  private readonly titles = new Map<string, string>();

  add(id: string, title: string): void {
    this.titles.set(id, title);
  }

  title(id: string): string | undefined {
    return this.titles.get(id);
  }
}

/** Turns the runtime's events into `session/update` notifications (see docs/lld/acp.md). */
export class EventMapper {
  constructor(
    private readonly channel: SessionChannel,
    private readonly calls: KnownCalls,
    private readonly root: string,
  ) {}

  event(event: AgentEvent): void {
    const send = (update: SessionUpdate) => this.channel.update(update);
    switch (event.type) {
      case "text_delta":
        send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } });
        break;
      case "thinking_delta":
        send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text } });
        break;
      case "tool_call": {
        const view = viewOf(event.call.name, event.call.input, this.root);
        this.calls.add(event.call.id, view.title);
        send({
          sessionUpdate: "tool_call",
          toolCallId: event.call.id,
          title: view.title,
          kind: view.kind,
          status: "pending",
          locations: view.locations,
          rawInput: event.call.input,
        });
        break;
      }
      case "tool_progress":
        send({
          sessionUpdate: "tool_call_update",
          toolCallId: event.call.id,
          status: "in_progress",
          content: [textContent(oneLine(event.text))],
        });
        break;
      case "tool_result":
        send({
          sessionUpdate: "tool_call_update",
          toolCallId: event.call.id,
          status: event.outcome.isError ? "failed" : "completed",
          content: [textContent(cut(event.outcome.content))],
        });
        break;
      case "server_tool": {
        const input = event.call.input as { query?: unknown } | undefined;
        const query = typeof input?.query === "string" ? input.query : "";
        const title = oneLine(`Search the web: ${query}`);
        this.calls.add(event.call.id, title);
        send({
          sessionUpdate: "tool_call",
          toolCallId: event.call.id,
          title,
          kind: "fetch",
          status: event.result === undefined ? "in_progress" : "completed",
        });
        if (event.result !== undefined) {
          const lines = event.result.results.map((r) => `${r.title} ${r.url}`);
          send({
            sessionUpdate: "tool_call_update",
            toolCallId: event.call.id,
            status: event.result.error === undefined ? "completed" : "failed",
            content: [textContent(cut(event.result.error ?? lines.join("\n")))],
          });
        }
        break;
      }
      case "notice":
        this.channel.notice(event.text);
        break;
      case "compaction":
        this.channel.notice("the conversation was summarised to fit the context window.");
        break;
      case "model_retry":
        this.channel.notice(
          `the model connection broke (${oneLine(event.reason)}). Retry ${event.attempt} of ${event.maxRetries}: the answer starts again below.`,
        );
        break;
      case "step_end":
        break;
    }
  }
}

function cut(text: string): string {
  return text.length <= RESULT_MAX_CHARS
    ? text
    : `${text.slice(0, RESULT_MAX_CHARS)}\n[Garuda: cut at ${RESULT_MAX_CHARS} characters for the editor; the model has all of it]`;
}
