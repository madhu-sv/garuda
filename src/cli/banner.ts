import { homedir } from "node:os";

/**
 * The chat start banner (0.2): a GARUDA wordmark with a saffron-to-gold gradient, then a card
 * with the session facts and one line of tips. Pure: the caller gives the terminal facts, so
 * tests need no terminal. Shown only for a chat, never for -p, pipes or evals.
 */

export type ColorLevel = "truecolor" | "basic" | "none";

export interface BannerInfo {
  version: string;
  model: string;
  /** For example "seatbelt · no network", or "none: commands ask first". */
  sandbox: string;
  root: string;
  /** Short facts, for example "Java (Maven)", "1 MCP server", "2 hooks", "web_fetch". */
  extras: string[];
  /** The Ink chat has a queue and Esc; the plain chat does not. */
  ink: boolean;
  /** Available subagents (explore, MoE specialists) for dedicated banner label. */
  subagents?: string[] | undefined;
  /** Custom agents for dedicated banner label. */
  agents?: string[] | undefined;
  /** Skills for dedicated banner label. */
  skills?: string[] | undefined;
  /** Tools and integrations for dedicated banner label. */
  tools?: string[] | undefined;
}

export interface BannerOptions {
  columns: number;
  color: ColorLevel;
  home?: string;
}

const WORDMARK = [
  " ██████   █████  ██████  ██    ██ ██████   █████ ",
  "██       ██   ██ ██   ██ ██    ██ ██   ██ ██   ██",
  "██   ███ ███████ ██████  ██    ██ ██   ██ ███████",
  "██    ██ ██   ██ ██   ██ ██    ██ ██   ██ ██   ██",
  " ██████  ██   ██ ██   ██  ██████  ██████  ██   ██",
];
/** Below this width the wordmark does not fit well: show the card only. */
export const WORDMARK_MIN_COLUMNS = 60;

// Deep saffron to gold.
const FROM = [255, 122, 24] as const;
const TO = [255, 209, 102] as const;

/** How many colors this terminal can show. NO_COLOR and pipes get none. */
export function colorLevel(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): ColorLevel {
  if (env.NO_COLOR !== undefined || stream.isTTY !== true || env.TERM === "dumb") return "none";
  return /truecolor|24bit/i.test(env.COLORTERM ?? "") ? "truecolor" : "basic";
}

export function banner(info: BannerInfo, options: BannerOptions): string {
  const c = paint(options.color);
  const lines: string[] = [];
  if (options.columns >= WORDMARK_MIN_COLUMNS) {
    const width = WORDMARK[0]?.length ?? 1;
    for (const row of WORDMARK) lines.push(c.gradient(row, width));
    lines.push("");
  }
  lines.push(...card(info, options, c));
  const tips = info.ink
    ? "/help · Esc stops a task · \\ then Enter: new line · Ctrl-G editor · Ctrl-P commands"
    : "/help · Ctrl-C stops a task · \\ at the end: new line";
  lines.push(c.dim(` ${tips}`), "");
  return lines.join("\n");
}

function card(info: BannerInfo, options: BannerOptions, c: Painter): string[] {
  const home = options.home ?? homedir();
  const folder =
    info.root === home || info.root.startsWith(`${home}/`)
      ? `~${info.root.slice(home.length)}`
      : info.root;
  const title = `✦ Garuda ${info.version} · a terminal coding agent`;
  const rows: [string, string][] = [
    ["model", info.model],
    ["sandbox", info.sandbox],
    ["folder", folder],
  ];

  const hasCategorized =
    (info.subagents !== undefined && info.subagents.length > 0) ||
    (info.agents !== undefined && info.agents.length > 0) ||
    (info.skills !== undefined && info.skills.length > 0) ||
    (info.tools !== undefined && info.tools.length > 0);

  if (hasCategorized) {
    if (info.subagents !== undefined && info.subagents.length > 0) {
      rows.push(["subagents", info.subagents.join(" · ")]);
    }
    if (info.agents !== undefined && info.agents.length > 0) {
      rows.push(["agents", info.agents.join(" · ")]);
    }
    if (info.skills !== undefined && info.skills.length > 0) {
      rows.push(["skills", info.skills.join(" · ")]);
    }
    if (info.tools !== undefined && info.tools.length > 0) {
      rows.push(["tools", info.tools.join(" · ")]);
    }
  } else if (info.extras.length > 0) {
    rows.push(["extras", info.extras.join(" · ")]);
  }

  // The card fits the terminal: at most columns - 2 wide, values cut from the start.
  const maxLabel = Math.max(...rows.map(([label]) => label.length));
  const labelWidth = Math.max(9, maxLabel + 2);
  const prefix = 2 + labelWidth;
  const natural = Math.max(title.length, ...rows.map(([, v]) => prefix + v.length));
  const inner = Math.max(20, Math.min(natural + 1, options.columns - 4));
  const cutStart = (text: string, max: number) =>
    text.length <= max ? text : `…${text.slice(text.length - max + 1)}`;

  const border = (left: string, right: string) => c.dim(`${left}${"─".repeat(inner + 2)}${right}`);
  const line = (plain: string, styled: string) =>
    `${c.dim("│")} ${styled}${" ".repeat(Math.max(0, inner - plain.length))} ${c.dim("│")}`;

  const titleText = cutStart(title, inner);
  const out = [
    border("╭", "╮"),
    line(
      titleText,
      titleText.startsWith("✦") ? `${c.gold("✦")}${c.bold(titleText.slice(1))}` : c.bold(titleText),
    ),
    line("", ""),
  ];
  for (const [label, value] of rows) {
    const shown = cutStart(value, inner - prefix);
    const plain = `  ${label.padEnd(labelWidth)}${shown}`;
    out.push(line(plain, `  ${c.dim(label.padEnd(labelWidth))}${shown}`));
  }
  out.push(border("╰", "╯"));
  return out;
}

interface Painter {
  gradient(text: string, width: number): string;
  gold(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
}

function paint(level: ColorLevel): Painter {
  const esc = (code: string, text: string, reset: string) =>
    `\u001b[${code}m${text}\u001b[${reset}m`;
  if (level === "none") {
    return { gradient: (t) => t, gold: (t) => t, bold: (t) => t, dim: (t) => t };
  }
  const bold = (t: string) => esc("1", t, "22");
  const dim = (t: string) => esc("2", t, "22");
  if (level === "basic") {
    return { gradient: (t) => esc("33", t, "39"), gold: (t) => esc("33", t, "39"), bold, dim };
  }
  const rgb = ([r, g, b]: readonly number[]) => `38;2;${r};${g};${b}`;
  return {
    gradient: (text, width) =>
      [...text]
        .map((ch, i) => {
          if (ch === " ") return ch;
          const t = width <= 1 ? 0 : i / (width - 1);
          const mix = FROM.map((f, k) => Math.round(f + ((TO[k] ?? f) - f) * t));
          return esc(rgb(mix), ch, "39");
        })
        .join(""),
    gold: (t) => esc(rgb(TO), t, "39"),
    bold,
    dim,
  };
}
