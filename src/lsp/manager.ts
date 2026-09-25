import type { ExecPolicy, Executor, RunningProcess } from "../sandbox/types.js";
import { LspClient, LspTimeoutError } from "./client.js";
import { formatDiagnostics } from "./format.js";
import {
  discoverServer,
  type FoundServer,
  findServer,
  LSP_LANGUAGES,
  type LspLanguage,
  languageOf,
} from "./servers.js";

/**
 * Starts language servers on first use, one per language, and turns their diagnostics into the
 * text after an edit result (0.4). A server runs through the Executor in the OS sandbox, with the
 * project read-only and no network. Nothing here may block an edit: a missing, slow or broken
 * server gives no text, and at most one notice.
 */

export type LspState = "idle" | "starting" | "running" | "missing" | "failed";

export interface LspServerStatus {
  language: LspLanguage;
  state: LspState;
  server?: FoundServer;
  /** Why it is missing or failed. */
  reason?: string;
  /** Programs that were found but cannot start (for example: no Java 21). */
  problems?: string[];
}

export interface LspManagerOptions {
  root: string;
  executor: Executor;
  /** The policy for servers: sandbox on, project read-only, no network. */
  policy: () => ExecPolicy;
  home?: string;
  /** PATH to search. Default: process.env.PATH. */
  path?: string;
  /** Environment for discovery (JAVA_HOME, PATH for java); default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** JDK folders to search for jdtls's Java; default: the usual places. */
  jdkFolders?: string[];
  notify?: (text: string) => void;
  /**
   * Called once per language when no server is found (autoInstall). True when a server was
   * installed; the manager then looks again.
   */
  install?: (language: LspLanguage, signal: AbortSignal) => Promise<boolean>;
  firstTimeoutMs?: number;
  timeoutMs?: number;
}

interface Slot {
  state: LspState;
  server?: FoundServer;
  reason?: string;
  client?: LspClient;
  starting?: Promise<LspClient | undefined> | undefined;
  process?: RunningProcess;
  stderr: string[];
  slowNoticed?: boolean;
}

export const LANGUAGE_LABELS: Readonly<Record<LspLanguage, string>> = {
  typescript: "TypeScript/JavaScript",
  python: "Python",
  java: "Java",
};

export class LspManager {
  private readonly slots = new Map<LspLanguage, Slot>();
  private closed = false;
  /** Aborted by close(): it stops warm starts. */
  private readonly lifetime = new AbortController();

  constructor(private readonly options: LspManagerOptions) {}

  /**
   * The diagnostics text for a file that a tool just wrote, or undefined: not a known language,
   * no server, a timeout, or Ctrl-C. `shown` is the path as the model sees it.
   */
  async diagnostics(
    absolute: string,
    shown: string,
    text: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const lang = languageOf(absolute);
    if (lang === undefined || this.closed) return undefined;
    const slot = this.slot(lang.language);
    const client = await this.client(lang.language, slot, signal);
    if (client === undefined || slot.server === undefined) return undefined;
    try {
      const items = await client.diagnostics(absolute, lang.id, text, signal);
      return formatDiagnostics(shown, slot.server.spec.name, items);
    } catch (error) {
      if (signal.aborted) return undefined;
      if (error instanceof LspTimeoutError) {
        if (!slot.slowNoticed) {
          slot.slowNoticed = true;
          this.notify(`${slot.server.spec.name}: ${error.message} Edits go on without it.`);
        }
        return undefined;
      }
      this.fail(lang.language, slot, (error as Error).message);
      return undefined;
    }
  }

  /** One line per language, for /lsp and `garuda lsp`. */
  status(): LspServerStatus[] {
    return LSP_LANGUAGES.map((language) => {
      const slot = this.slots.get(language);
      const found =
        slot?.server === undefined ? findServer(language, this.discoverOptions()) : undefined;
      const server = slot?.server ?? found?.server;
      const state: LspState = slot?.state ?? (server === undefined ? "missing" : "idle");
      return {
        language,
        state,
        ...(server === undefined ? {} : { server }),
        ...(slot?.reason === undefined ? {} : { reason: slot.reason }),
        ...(found !== undefined && found.problems.length > 0 ? { problems: found.problems } : {}),
      };
    });
  }

  /**
   * Start a language's server now, in the background, so the first edit does not wait for the
   * project import (jdtls). It never asks to install, and failures only give the usual notice.
   */
  warm(language: LspLanguage): void {
    if (this.closed) return;
    const slot = this.slot(language);
    if (slot.state !== "idle") return;
    if (discoverServer(language, this.discoverOptions()) === undefined) return;
    void this.client(language, slot, this.lifetime.signal)
      .then((client) => client?.ready)
      .catch(() => undefined);
  }

  /** Forget a missing or failed server, so the next edit looks again (after an install). */
  reset(language: LspLanguage): void {
    const slot = this.slots.get(language);
    if (slot === undefined || slot.state === "running" || slot.state === "starting") return;
    this.slots.delete(language);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort(new Error("Garuda is closing."));
    const slots = [...this.slots.values()];
    await Promise.all(
      slots.map(async (slot) => {
        const client = slot.client ?? (await slot.starting?.catch(() => undefined));
        if (client !== undefined) await client.close();
        else slot.process?.stop();
      }),
    );
  }

  private slot(language: LspLanguage): Slot {
    let slot = this.slots.get(language);
    if (slot === undefined) {
      slot = { state: "idle", stderr: [] };
      this.slots.set(language, slot);
    }
    return slot;
  }

  private async client(
    language: LspLanguage,
    slot: Slot,
    signal: AbortSignal,
  ): Promise<LspClient | undefined> {
    if (slot.state === "missing" || slot.state === "failed") return undefined;
    if (slot.client !== undefined) {
      if (!slot.client.isClosed) return slot.client;
      this.fail(language, slot, this.stopped(slot));
      return undefined;
    }
    slot.starting ??= this.start(language, slot, signal).finally(() => {
      slot.starting = undefined;
    });
    return slot.starting;
  }

  private async start(
    language: LspLanguage,
    slot: Slot,
    signal: AbortSignal,
  ): Promise<LspClient | undefined> {
    slot.state = "starting";
    let server = discoverServer(language, this.discoverOptions());
    if (server === undefined && this.options.install !== undefined) {
      if (await this.options.install(language, signal).catch(() => false)) {
        server = discoverServer(language, this.discoverOptions());
      }
    }
    if (server === undefined) {
      slot.state = "missing";
      slot.reason = `no server found. Run "garuda lsp install ${language}".`;
      return undefined;
    }
    slot.server = server;
    if (this.options.executor.isolation === "none") {
      // Servers read project config and can run project programs (a Python venv): sandbox only.
      this.fail(language, slot, "it needs the OS sandbox, and this session has none");
      return undefined;
    }
    try {
      const process = this.options.executor.start(server.argv, this.options.policy());
      slot.process = process;
      process.stderr.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.trim() === "") continue;
          slot.stderr.push(line.slice(0, 300));
          if (slot.stderr.length > 20) slot.stderr.shift();
        }
      });
      process.onError(() => {});
      const { spec } = server;
      const firstTimeoutMs = this.options.firstTimeoutMs ?? spec.firstTimeoutMs;
      const client = await LspClient.start(
        process,
        {
          root: this.options.root,
          ...(firstTimeoutMs === undefined ? {} : { firstTimeoutMs }),
          ...(spec.initializationOptions === undefined
            ? {}
            : { initializationOptions: spec.initializationOptions }),
          ...(spec.ready === undefined ? {} : { ready: spec.ready }),
          ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
        },
        signal,
      );
      if (this.closed) {
        await client.close();
        return undefined;
      }
      slot.client = client;
      slot.state = "running";
      return client;
    } catch (error) {
      slot.process?.stop();
      if (signal.aborted) {
        // Ctrl-C during the start: try again at the next edit.
        slot.state = "idle";
        return undefined;
      }
      const why = error instanceof LspTimeoutError ? error.message : this.stopped(slot, error);
      this.fail(language, slot, why);
      return undefined;
    }
  }

  private stopped(slot: Slot, error?: unknown): string {
    const last = slot.stderr.at(-1);
    const base = error instanceof Error ? error.message : "the server stopped";
    return last === undefined ? base : `${base} (${last})`;
  }

  private fail(language: LspLanguage, slot: Slot, reason: string): void {
    if (slot.state === "failed") return;
    slot.state = "failed";
    slot.reason = reason;
    slot.process?.stop();
    const name = slot.server?.spec.name ?? "the language server";
    this.notify(
      `${LANGUAGE_LABELS[language]} diagnostics are off for this session: ${name}: ${reason}`,
    );
  }

  private notify(text: string): void {
    this.options.notify?.(text);
  }

  private discoverOptions() {
    const o = this.options;
    return {
      root: o.root,
      ...(o.home === undefined ? {} : { home: o.home }),
      ...(o.path === undefined ? {} : { path: o.path }),
      ...(o.env === undefined ? {} : { env: o.env }),
      ...(o.jdkFolders === undefined ? {} : { jdkFolders: o.jdkFolders }),
    };
  }
}

/** The /lsp and `garuda lsp` text. */
export function lspStatusText(
  statuses: readonly LspServerStatus[],
  enabled: { on: boolean; how: string },
): string {
  const lines = [
    enabled.on
      ? "LSP diagnostics are on: edit_file and write_file add the errors of the changed file."
      : `LSP diagnostics are off. ${enabled.how}`,
  ];
  for (const s of statuses) {
    const label = LANGUAGE_LABELS[s.language];
    if (s.server === undefined) {
      const why = s.problems === undefined ? "" : ` (${s.problems.join("; ")})`;
      lines.push(`  ${label}: not found${why}. Run "garuda lsp install ${s.language}".`);
      continue;
    }
    const where = s.server.source === "managed" ? "managed" : "PATH";
    const state =
      s.state === "failed"
        ? `failed: ${s.reason ?? "unknown"}`
        : s.state === "running"
          ? "running"
          : "found";
    lines.push(`  ${label}: ${s.server.spec.name} (${where}, ${s.server.path}), ${state}`);
  }
  return lines.join("\n");
}
