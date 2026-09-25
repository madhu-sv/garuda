import type { ExecPolicy, Executor, RunningProcess } from "../sandbox/types.js";
import { LspClient, LspTimeoutError } from "./client.js";
import { formatDiagnostics } from "./format.js";
import {
  discoverServer,
  type FoundServer,
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
}

export interface LspManagerOptions {
  root: string;
  executor: Executor;
  /** The policy for servers: sandbox on, project read-only, no network. */
  policy: () => ExecPolicy;
  home?: string;
  /** PATH to search. Default: process.env.PATH. */
  path?: string;
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
};

export class LspManager {
  private readonly slots = new Map<LspLanguage, Slot>();
  private closed = false;

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
      const server = slot?.server ?? discoverServer(language, this.discoverOptions());
      const state: LspState = slot?.state ?? (server === undefined ? "missing" : "idle");
      return {
        language,
        state,
        ...(server === undefined ? {} : { server }),
        ...(slot?.reason === undefined ? {} : { reason: slot.reason }),
      };
    });
  }

  /** Forget a missing or failed server, so the next edit looks again (after an install). */
  reset(language: LspLanguage): void {
    const slot = this.slots.get(language);
    if (slot === undefined || slot.state === "running" || slot.state === "starting") return;
    this.slots.delete(language);
  }

  async close(): Promise<void> {
    this.closed = true;
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
      const process = this.options.executor.start(
        [server.path, ...server.spec.args],
        this.options.policy(),
      );
      slot.process = process;
      process.stderr.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.trim() === "") continue;
          slot.stderr.push(line.slice(0, 300));
          if (slot.stderr.length > 20) slot.stderr.shift();
        }
      });
      process.onError(() => {});
      const client = await LspClient.start(
        process,
        {
          root: this.options.root,
          ...(this.options.firstTimeoutMs === undefined
            ? {}
            : { firstTimeoutMs: this.options.firstTimeoutMs }),
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
    return {
      root: this.options.root,
      ...(this.options.home === undefined ? {} : { home: this.options.home }),
      ...(this.options.path === undefined ? {} : { path: this.options.path }),
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
      lines.push(`  ${label}: not found. Run "garuda lsp install ${s.language}".`);
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
