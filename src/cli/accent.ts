import { type ColorLevel, colorLevel, SAFFRON } from "./banner.js";

/**
 * The chat's accent (UX U12, "Brand" in docs/lld/ux.md): the banner's saffron on the spinner, the
 * receipt border, the plan's current step, Garuda's mark and the selected choice. Cyan stays for
 * links, paths and the user's bar. A 16-color terminal gets yellow; NO_COLOR and pipes get none.
 */
export const ACCENT_HEX = `#${SAFFRON.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

let level: ColorLevel | undefined;
/** The chat's color level, read once (the chat draws on stdout). */
export function accentLevel(): ColorLevel {
  level ??= colorLevel(process.stdout);
  return level;
}

/** The accent as an Ink color; undefined draws the text in the terminal's own color. */
export function accentInk(at: ColorLevel = accentLevel()): string | undefined {
  if (at === "truecolor") return ACCENT_HEX;
  return at === "basic" ? "yellow" : undefined;
}

/** Text in the accent, for lines that are built as ANSI strings. */
export function accentAnsi(text: string, at: ColorLevel = accentLevel()): string {
  if (at === "none") return text;
  const code = at === "truecolor" ? `38;2;${SAFFRON.join(";")}` : "33";
  return `\u001b[${code}m${text}\u001b[39m`;
}
