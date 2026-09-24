import { styleText } from "node:util";

/**
 * Basic markdown for model text in the chat (0.2). Streaming text is cut into blocks at
 * blank lines (not inside code fences). Each finished block gets styles; the open block
 * shows as plain text until it ends.
 */

type Style = Parameters<typeof styleText>[0];
export type Paint = (style: Style, text: string) => string;

export const ansi: Paint = (style, text) => styleText(style, text, { validateStream: false });
export const noColor: Paint = (_style, text) => text;

/** Cut finished blocks off the front of `buffer`. `rest` is the open block. */
export function takeBlocks(buffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  const lines = buffer.split("\n");
  // The last element has no new line after it yet: it stays open.
  const open = lines.pop() ?? "";
  let current: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      current.push(line);
      inFence = !inFence;
      if (!inFence) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    if (!inFence && line.trim() === "") {
      if (current.length > 0) blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  // Lines of the unfinished block go back into the rest.
  return { blocks, rest: [...current, open].join("\n") };
}

/** Styles for one markdown block. */
export function renderMarkdown(block: string, paint: Paint = ansi): string {
  const lines = block.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(`  ${paint("cyan", line)}`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = inline(heading[2] ?? "", paint);
      out.push(heading[1] === "#" ? paint(["bold", "underline"], text) : paint("bold", text));
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}• ${inline(bullet[2] ?? "", paint)}`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(paint("dim", `│ ${quote[1] ?? ""}`));
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      out.push(paint("dim", "─".repeat(40)));
      continue;
    }
    out.push(inline(line, paint));
  }
  return out.join("\n");
}

/** Inline code, bold, italic and links. Code spans are not styled inside. */
export function inline(text: string, paint: Paint = ansi): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
        return paint("cyan", part.slice(1, -1));
      }
      return part
        .replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => paint("bold", t))
        .replace(
          /(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g,
          (_m, pre: string, t: string) => pre + paint("italic", t),
        )
        .replace(
          /(^|[^\w])_([^_\s][^_]*)_(?!\w)/g,
          (_m, pre: string, t: string) => pre + paint("italic", t),
        )
        .replace(
          /\[([^\]]+)\]\(([^)]+)\)/g,
          (_m, t: string, url: string) => `${t} ${paint("dim", `(${url})`)}`,
        );
    })
    .join("");
}
