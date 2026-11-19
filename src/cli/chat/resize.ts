/**
 * Resize recovery (0.21.x). The Ink chat draws on the primary screen, so finished lines stay in the
 * scrollback. When the terminal resizes, it reflows the soft-wrapped lines already on screen, but
 * Ink erases its live frame by a line count (`eraseLines(previousLineCount)`) that no longer matches
 * the rows the reflow produced. On a wider window the old frame is left behind and the new one
 * overlaps it; on a narrower one (a split pane is a resize too) the old frame's rewrapped rows stay
 * above the new one. Every row-relative erase fails the same way, because a soft-wrapped line is one
 * row before the resize and several after, so the count can never be right. A tracked cursor does
 * not save it either: Ink's cursor row is in its own un-reflowed coordinates.
 *
 * The only cure that survives reflow is an absolute repaint at the new width: erase the whole
 * viewport with no row count, then draw the view again from scratch. Ink has no public "repaint
 * everything" call — a fresh render re-emits the `<Static>` scrollback, a live re-render does not —
 * so the repaint unmounts and mounts again. The store holds the state, so the new mount shows the
 * same view. A short debounce coalesces the burst of resize events a drag sends into one repaint.
 *
 * The cost is that the mount re-emits the finished lines, so the scrollback holds the conversation
 * once more after each resize. That keeps the active view correct, which the primary screen cannot
 * otherwise guarantee; the alternate screen would avoid the repaint but drop the scrollback, which
 * is the trade this chat has chosen against.
 */

/** Home the cursor and erase to the end of the screen. Absolute, so no reflow can throw it off. */
export const HOME_AND_ERASE_DOWN = "\u001b[H\u001b[J";

/**
 * A clear screen that keeps what was there (0.18.1): new lines push the old screen up into the
 * scrollback, as `clear` does in most terminals, then the cursor goes to the top. ESC[2J alone
 * drops the old screen in some terminals.
 */
export function clearScreenKeepingScrollback(rows: number): string {
  return `${"\n".repeat(Math.max(1, rows))}\u001b[H`;
}

/** The stdout the chat watches for resize. The real `process.stdout` and a test double both fit. */
export interface ResizableOutput {
  columns?: number;
  rows?: number;
  write(data: string): void;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

/** The part of the Ink render instance the repaint unmounts. */
export interface Unmountable {
  unmount(): void;
}

/**
 * Repaint the whole view at the new size. Unmount first so the old frame stops, erase the viewport
 * absolutely (a row count would be wrong after reflow), then `remount` mounts a fresh Ink render,
 * which draws the view again from the top of the cleared screen.
 */
export function repaintFresh(stdout: ResizableOutput, ink: Unmountable, remount: () => void): void {
  ink.unmount();
  stdout.write(HOME_AND_ERASE_DOWN);
  remount();
}

/**
 * Watch `stdout` for resize and call `onSettle` once the size stops changing. Events that do not
 * change the size are ignored; a burst is coalesced with a trailing debounce. Returns a function
 * that detaches the listener and drops any pending repaint.
 */
export function watchResize(
  stdout: ResizableOutput,
  onSettle: () => void,
  delayMs = 80,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastColumns = stdout.columns;
  let lastRows = stdout.rows;
  const onResize = () => {
    if (stdout.columns === lastColumns && stdout.rows === lastRows) return;
    lastColumns = stdout.columns;
    lastRows = stdout.rows;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onSettle();
    }, delayMs);
  };
  stdout.on("resize", onResize);
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    stdout.off("resize", onResize);
  };
}
