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
  /** 0.18.1: centre each line in the terminal (the Ink chat), with the 3D wordmark. */
  center?: boolean;
  /** The terminal's rows: with `center`, some space above the banner on a tall screen. */
  rows?: number;
  /** UX U12: no wordmark (a screen reader reads block characters as noise). */
  screenReader?: boolean;
}

/** From this width the 3D wordmark is drawn twice as large (0.18.1). */
export const WORDMARK_LARGE_COLUMNS = 130;

/**
 * The wordmark with a drop shadow (0.18.1: "make it look 3D"). The letters' cells come from
 * WORDMARK; each is drawn `scale` times as wide and as tall. The shadow is the same shape, moved
 * one row down and one cell (two when large) right, so it shows below and right of each stroke.
 * Pure: `face` and `shadow` paint one cell at column x of `width`.
 */
export function wordmark3d(
  scale: 1 | 2,
  face: (x: number, width: number) => string,
  shadow: (x: number, width: number) => string,
): string[] {
  const rows = WORDMARK.map((row) => row.padEnd(Math.max(...WORDMARK.map((r) => r.length))));
  const lit = (x: number, y: number) =>
    x >= 0 && y >= 0 && rows[Math.floor(y / scale)]?.[Math.floor(x / scale)] === "█";
  const dx = scale;
  const dy = 1;
  const width = (rows[0]?.length ?? 0) * scale + dx;
  const height = rows.length * scale + dy;
  const out: string[] = [];
  for (let y = 0; y < height; y++) {
    let line = "";
    for (let x = 0; x < width; x++) {
      line += lit(x, y) ? face(x, width) : lit(x - dx, y - dy) ? shadow(x, width) : " ";
    }
    out.push(line.replace(/\s+$/, ""));
  }
  return out;
}

/** The width of a line on screen: no escape codes. */
export function visibleWidth(line: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape codes are the point.
  return [...line.replace(/\u001b\[[0-9;]*m/g, "")].length;
}

/** Lines that belong together (the wordmark, the card) move as one block, so they stay aligned. */
export function centerBlock(lines: readonly string[], width: number, columns: number): string[] {
  const pad = Math.floor((columns - width) / 2);
  return pad <= 0 ? [...lines] : lines.map((line) => `${" ".repeat(pad)}${line}`);
}

/** Each line with spaces before it, so it sits in the middle of `columns`. */
export function centerLines(lines: readonly string[], columns: number): string[] {
  return lines.map((line) => {
    const pad = Math.floor((columns - visibleWidth(line)) / 2);
    return line === "" || pad <= 0 ? line : `${" ".repeat(pad)}${line}`;
  });
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
  // With the 3D wordmark, the card is as wide as the wordmark, so the two read as one block.
  let markWidth: number | undefined;
  const block = (rows: string[], width: number) =>
    options.center === true ? centerBlock(rows, width, options.columns) : rows;
  if (options.screenReader === true) {
    // No wordmark: the card says the name.
  } else if (options.center === true && options.columns >= WORDMARK_MIN_COLUMNS) {
    // The 3D wordmark, large on a wide screen; a tall screen gets some space above it.
    const scale = options.columns >= WORDMARK_LARGE_COLUMNS ? 2 : 1;
    const mark = wordmark3d(scale, c.face, c.shadow);
    const height = mark.length + 12;
    const top = options.rows === undefined ? 0 : Math.floor((options.rows - height) / 4);
    for (let i = 0; i < Math.min(Math.max(0, top), 6); i++) lines.push("");
    markWidth = Math.max(...mark.map(visibleWidth));
    lines.push(...block(mark, markWidth), "");
  } else if (options.columns >= WORDMARK_MIN_COLUMNS) {
    const width = Math.max(...WORDMARK.map((row) => row.length));
    lines.push(
      ...block(
        WORDMARK.map((row) => c.gradient(row, width)),
        width,
      ),
      "",
    );
  }
  const cardLines = card(info, options, c, markWidth);
  lines.push(...block(cardLines, Math.max(...cardLines.map(visibleWidth))));
  const tips = info.ink
    ? "/help · Esc stops a task · \\ then Enter: new line · Ctrl-G editor · Ctrl-P commands"
    : "/help · Ctrl-C stops a task · \\ at the end: new line";
  if (options.center === true) {
    lines.push(...centerLines([c.dim(tips)], options.columns), "");
    return lines.join("\n");
  }
  lines.push(c.dim(` ${tips}`), "");
  return lines.join("\n");
}

function card(
  info: BannerInfo,
  options: BannerOptions,
  c: Painter,
  /** The card's width at least, when it fits (0.18.1: the width of the 3D wordmark). */
  minWidth?: number,
): string[] {
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
  const inner = Math.max(
    20,
    Math.min(Math.max(natural + 1, (minWidth ?? 0) - 4), options.columns - 4),
  );
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
  /** One lit cell of the 3D wordmark at column x of width. */
  face(x: number, width: number): string;
  /** One shadow cell: a darker shade of the same colour; ░ with no colour. */
  shadow(x: number, width: number): string;
  gold(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
}

function paint(level: ColorLevel): Painter {
  const esc = (code: string, text: string, reset: string) =>
    `\u001b[${code}m${text}\u001b[${reset}m`;
  if (level === "none") {
    return {
      gradient: (t) => t,
      face: () => "█",
      shadow: () => "░",
      gold: (t) => t,
      bold: (t) => t,
      dim: (t) => t,
    };
  }
  const bold = (t: string) => esc("1", t, "22");
  const dim = (t: string) => esc("2", t, "22");
  if (level === "basic") {
    return {
      gradient: (t) => esc("33", t, "39"),
      face: () => esc("33", "█", "39"),
      shadow: () => esc("31", "▓", "39"),
      gold: (t) => esc("33", t, "39"),
      bold,
      dim,
    };
  }
  const rgb = ([r, g, b]: readonly number[]) => `38;2;${r};${g};${b}`;
  const mixAt = (x: number, width: number) => {
    const t = width <= 1 ? 0 : x / (width - 1);
    return FROM.map((f, k) => Math.round(f + ((TO[k] ?? f) - f) * t));
  };
  return {
    face: (x, width) => esc(rgb(mixAt(x, width)), "█", "39"),
    // The shadow: the face's colour at half its brightness, so it reads as depth on light and
    // dark backgrounds.
    shadow: (x, width) => esc(rgb(mixAt(x, width).map((v) => Math.round(v * 0.45))), "█", "39"),
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
