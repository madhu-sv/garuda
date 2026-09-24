import {
  type JSONRPCMessage,
  ReadBuffer,
  serializeMessage,
  type Transport,
} from "@modelcontextprotocol/client";
import type { RunningProcess } from "../sandbox/types.js";

/** Largest JSON-RPC line Garuda accepts from a server. A larger one is an error. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Lines of server stderr kept for error messages and /mcp. */
const STDERR_LINES = 40;

/**
 * An MCP stdio transport over a process that Garuda's Executor started (N8), so the server
 * runs in the OS sandbox. The SDK's own stdio transport spawns processes itself; Garuda
 * never uses it.
 */
export class ProcessTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private readonly buffer = new ReadBuffer({ maxBufferSize: MAX_MESSAGE_BYTES });
  private readonly stderr: string[] = [];
  private closed = false;

  constructor(private readonly process: RunningProcess) {}

  async start(): Promise<void> {
    const p = this.process;
    p.stdout.on("data", (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        for (;;) {
          const message = this.buffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message);
        }
      } catch (error) {
        // A bad line or an oversized message: report it and stop reading this server.
        this.onerror?.(error as Error);
        this.buffer.clear();
      }
    });
    p.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() === "") continue;
        this.stderr.push(line.slice(0, 500));
        if (this.stderr.length > STDERR_LINES) this.stderr.shift();
      }
    });
    p.stdin.on("error", (error: Error) => this.onerror?.(error));
    p.onError((error) => this.onerror?.(error));
    p.onExit(() => this.finish());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("The MCP server has stopped.");
    const line = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      this.process.stdin.write(line, (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.process.stdin.end();
    this.process.stop();
    this.finish();
  }

  /** The last lines the server wrote to stderr. */
  lastStderr(): string[] {
    return [...this.stderr];
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer.clear();
    this.onclose?.();
  }
}
