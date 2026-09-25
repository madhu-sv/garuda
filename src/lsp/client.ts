import { pathToFileURL } from "node:url";
import type { MessageConnection } from "vscode-jsonrpc/node";
import type { RunningProcess } from "../sandbox/types.js";

/**
 * A small LSP client for diagnostics only (0.4). It speaks JSON-RPC with vscode-jsonrpc over the
 * pipes of a process that the Executor started (N8). It opens files, sends their full text on each
 * change, and gets diagnostics by pull (textDocument/diagnostic) when the server offers it, else
 * from publishDiagnostics.
 */

/** An LSP diagnostic, reduced to what Garuda shows. */
export interface Diagnostic {
  line: number;
  character: number;
  /** 1 error, 2 warning, 3 information, 4 hint. Missing means the server did not say. */
  severity?: number;
  message: string;
  code?: string | number;
}

interface RawDiagnostic {
  range?: { start?: { line?: number; character?: number } };
  severity?: number;
  message?: unknown;
  code?: unknown;
}

interface OpenDocument {
  version: number;
  text: string;
}

export interface LspClientOptions {
  root: string;
  /** Wait for the first result of a server (it loads the project first). */
  firstTimeoutMs?: number;
  /** Wait for the answer to initialize. A slow start is not a slow check. Default: 30 s. */
  initTimeoutMs?: number;
  /** Wait for later results. */
  timeoutMs?: number;
}

export class LspTimeoutError extends Error {
  constructor(ms: number) {
    super(`The language server gave no diagnostics within ${ms / 1000} s.`);
  }
}

export class LspClient {
  private readonly documents = new Map<string, OpenDocument>();
  /** Diagnostics from publishDiagnostics, by URI, with the version they are for. */
  private readonly published = new Map<string, { version?: number; items: RawDiagnostic[] }>();
  private readonly waiters = new Set<() => void>();
  private pull = false;
  private answered = false;
  private closed = false;

  private constructor(
    private readonly connection: MessageConnection,
    private readonly process: RunningProcess,
    private readonly options: LspClientOptions,
  ) {}

  /** Connect to a started server and run the LSP handshake. */
  static async start(
    process: RunningProcess,
    options: LspClientOptions,
    signal: AbortSignal,
  ): Promise<LspClient> {
    // vscode-jsonrpc loads only when a language server starts (N3).
    const rpc = await import("vscode-jsonrpc/node");
    const connection = rpc.createMessageConnection(
      new rpc.StreamMessageReader(process.stdout),
      new rpc.StreamMessageWriter(process.stdin),
    );
    const client = new LspClient(connection, process, options);
    client.listen();
    connection.listen();
    await client.initialize(signal);
    return client;
  }

  private listen(): void {
    const c = this.connection;
    // Server requests: settings get "no value", and other requests an empty answer.
    c.onRequest("workspace/configuration", (params: { items?: unknown[] }) =>
      (params?.items ?? []).map(() => null),
    );
    c.onRequest(() => null);
    c.onNotification(
      "textDocument/publishDiagnostics",
      (params: { uri: string; version?: number; diagnostics?: RawDiagnostic[] }) => {
        this.published.set(params.uri, {
          ...(params.version === undefined ? {} : { version: params.version }),
          items: params.diagnostics ?? [],
        });
        for (const wake of this.waiters) wake();
      },
    );
    // Log and progress messages are not needed.
    c.onNotification(() => {});
    c.onClose(() => this.finish());
    c.onError(() => {});
    this.process.onExit(() => this.finish());
  }

  private async initialize(signal: AbortSignal): Promise<void> {
    const rootUri = pathToFileURL(this.options.root).href;
    const result = (await this.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "garuda" },
        rootUri,
        rootPath: this.options.root,
        workspaceFolders: [{ uri: rootUri, name: "root" }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            publishDiagnostics: { versionSupport: true, relatedInformation: false },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          },
          workspace: { configuration: true, workspaceFolders: true },
          window: { workDoneProgress: false },
        },
      },
      this.options.initTimeoutMs ?? 30_000,
      signal,
    )) as { capabilities?: { diagnosticProvider?: unknown } } | null;
    this.pull = result?.capabilities?.diagnosticProvider != null;
    await this.connection.sendNotification("initialized", {});
  }

  /** True when the server answers diagnostic requests (pull), not only publishDiagnostics. */
  get usesPull(): boolean {
    return this.pull;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Send the file's text and return its diagnostics. It throws LspTimeoutError when the server
   * is too slow; the caller then shows nothing.
   */
  async diagnostics(
    path: string,
    languageId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<Diagnostic[]> {
    if (this.closed) throw new Error("The language server has stopped.");
    const uri = pathToFileURL(path).href;
    const version = await this.sync(uri, languageId, text);
    const ms = this.answered
      ? (this.options.timeoutMs ?? 5_000)
      : (this.options.firstTimeoutMs ?? 30_000);
    const items = this.pull
      ? await this.pullDiagnostics(uri, ms, signal)
      : await this.waitPublished(uri, version, ms, signal);
    this.answered = true;
    return items.map(toDiagnostic);
  }

  /**
   * didOpen the first time, then didChange with the full text. Returns the new version. Old
   * published diagnostics are dropped before the send, so a fast answer is never lost.
   */
  private async sync(uri: string, languageId: string, text: string): Promise<number> {
    this.published.delete(uri);
    const open = this.documents.get(uri);
    if (open === undefined) {
      this.documents.set(uri, { version: 1, text });
      await this.connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
      return 1;
    }
    const version = open.version + 1;
    this.documents.set(uri, { version, text });
    await this.connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    return version;
  }

  private async pullDiagnostics(
    uri: string,
    ms: number,
    signal: AbortSignal,
  ): Promise<RawDiagnostic[]> {
    const report = (await this.request(
      "textDocument/diagnostic",
      { textDocument: { uri } },
      ms,
      signal,
    )) as { kind?: string; items?: RawDiagnostic[] } | null;
    return report?.items ?? [];
  }

  /** Wait for publishDiagnostics for this version (or any new result, if it sends no version). */
  private waitPublished(
    uri: string,
    version: number,
    ms: number,
    signal: AbortSignal,
  ): Promise<RawDiagnostic[]> {
    const ready = (): RawDiagnostic[] | undefined => {
      const got = this.published.get(uri);
      if (got === undefined) return undefined;
      if (got.version !== undefined && got.version < version) return undefined;
      return got.items;
    };
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const done = (fn: () => void) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        signal.removeEventListener("abort", onAbort);
        fn();
      };
      const check = () => {
        const items = ready();
        if (items !== undefined) done(() => resolve(items));
        else if (this.closed) done(() => reject(new Error("The language server has stopped.")));
      };
      const onAbort = () => done(() => reject(signal.reason));
      const timer = setTimeout(() => done(() => reject(new LspTimeoutError(ms))), ms);
      this.waiters.add(check);
      signal.addEventListener("abort", onAbort, { once: true });
      check();
    });
  }

  private async request(
    method: string,
    params: unknown,
    ms: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) throw signal.reason;
    const rpc = await import("vscode-jsonrpc/node");
    const cancel = new rpc.CancellationTokenSource();
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        cancel.dispose();
        fn();
      };
      const onAbort = () => {
        cancel.cancel();
        done(() => reject(signal.reason));
      };
      const timer = setTimeout(() => {
        cancel.cancel();
        done(() => reject(new LspTimeoutError(ms)));
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
      this.connection.sendRequest(method, params, cancel.token).then(
        (value) => done(() => resolve(value)),
        (error: unknown) => done(() => reject(error)),
      );
    });
  }

  /** Polite stop: shutdown and exit, then stop the process in any case. */
  async close(): Promise<void> {
    if (!this.closed) {
      const quick = AbortSignal.timeout(2_000);
      try {
        await this.request("shutdown", null, 2_000, quick);
        await this.connection.sendNotification("exit");
      } catch {
        // The server is gone or slow: stop it below.
      }
    }
    this.finish();
    this.process.stop();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    for (const wake of this.waiters) wake();
    this.connection.dispose();
  }
}

function toDiagnostic(raw: RawDiagnostic): Diagnostic {
  const start = raw.range?.start;
  const code = raw.code;
  return {
    line: (start?.line ?? 0) + 1,
    character: (start?.character ?? 0) + 1,
    ...(typeof raw.severity === "number" ? { severity: raw.severity } : {}),
    message: typeof raw.message === "string" ? raw.message : String(raw.message ?? ""),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
  };
}
