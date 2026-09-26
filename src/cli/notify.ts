import type { NotifyChoice } from "../permissions/settings.js";
import type { ApprovalRequest } from "../permissions/types.js";
import type { TurnOutcome, TurnWatcher } from "./turn.js";

/**
 * Notifications in the chat (0.6): Garuda tells the user when an approval waits for an answer,
 * and when a long turn ends, so the user can work in another window. It only writes escape codes
 * to the terminal; it starts no process (N8).
 *
 * - "osc9": `ESC ] 9 ; text BEL`, a desktop notification in iTerm2, Ghostty and WezTerm.
 * - "bell": BEL. The terminal decides what it does (a sound, a badge or a bounce in the Dock).
 * - "auto": osc9 in those terminals (not inside tmux or screen, which drop it), else bell.
 */
export type NotifyChannel = "osc9" | "bell" | "off";

export const DEFAULT_AFTER_SECONDS = 10;
const MAX_TEXT = 120;

const OSC9_TERMINALS = new Set(["iTerm.app", "ghostty", "WezTerm"]);

export function pickChannel(
  choice: NotifyChoice | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NotifyChannel {
  const fromEnv = env.GARUDA_NOTIFY;
  const wanted: string = fromEnv !== undefined && fromEnv !== "" ? fromEnv : (choice ?? "auto");
  if (wanted === "off" || wanted === "bell" || wanted === "osc9") return wanted;
  const multiplexer = env.TMUX !== undefined || (env.TERM ?? "").startsWith("screen");
  return !multiplexer && OSC9_TERMINALS.has(env.TERM_PROGRAM ?? "") ? "osc9" : "bell";
}

/** The bytes to write for one notification. Control characters in the text are dropped. */
export function notificationBytes(channel: NotifyChannel, text: string): string {
  if (channel === "off") return "";
  if (channel === "bell") return "\x07";
  // Control characters (C0, DEL, C1) could end the escape code early: they become spaces.
  const clean = Array.from(text, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  })
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
  const cut = clean.length <= MAX_TEXT ? clean : `${clean.slice(0, MAX_TEXT - 1)}…`;
  return `\x1b]9;${cut}\x07`;
}

export class Notifier implements TurnWatcher {
  /** Questions notify only during a turn: after a command the user typed (/undo), the user is here. */
  private running = false;

  constructor(
    readonly channel: NotifyChannel,
    private readonly write: (bytes: string) => void,
    readonly afterSeconds: number = DEFAULT_AFTER_SECONDS,
  ) {}

  /** An approval or a consent question waits for the user. */
  approval(request: ApprovalRequest): void {
    if (!this.running) return;
    const target = request.target;
    const what =
      request.title ??
      (target.kind === "command"
        ? `${request.tool}: ${target.command.split("\n")[0] ?? ""}`
        : target.kind === "path"
          ? `${request.tool} ${target.path}`
          : request.tool);
    this.send(`Garuda needs your approval: ${what}`);
  }

  turnStarted(): void {
    this.running = true;
  }

  /** A turn ended. Short turns and turns the user stopped stay quiet. */
  turnEnded(outcome: TurnOutcome | undefined, ms: number): void {
    this.running = false;
    if (outcome === undefined || outcome.kind === "interrupted") return;
    if (ms < this.afterSeconds * 1_000) return;
    const time = formatSeconds(ms);
    if (outcome.kind === "error") this.send(`Garuda: the task failed after ${time}.`);
    else if (outcome.result.stopReason === "done") this.send(`Garuda: the task is done (${time}).`);
    else this.send(`Garuda: the task stopped (${outcome.result.stopReason}) after ${time}.`);
  }

  private send(text: string): void {
    const bytes = notificationBytes(this.channel, text);
    if (bytes !== "") this.write(bytes);
  }
}

function formatSeconds(ms: number): string {
  const s = Math.round(ms / 1_000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
