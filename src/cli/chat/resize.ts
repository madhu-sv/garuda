/**
 * Resize recovery (0.21.x). The Ink chat draws on the primary screen, so finished lines stay in the
 * scrollback. Ink clears before a re-render only when the terminal gets NARROWER (or shorter with
 * the cursor shown). When it gets WIDER, Ink re-renders with a line-relative erase
 * (`eraseLines(previousLineCount)`), but the terminal has already reflowed the soft-wrapped live
 * frame, so the erase count no longer matches the rows on screen: the old frame is left behind and
 * the new one overlaps it. Opening a split pane resizes the window too, so the same thing shows
 * there.
 *
 * The cure is an absolute clear, which needs no row count and so cannot be thrown off by reflow:
 * push the viewport into the scrollback and home the cursor, reset Ink's frame memory, then draw a
 * fresh frame. A short debounce coalesces the burst of resize events a drag sends into one redraw.
 */

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

/** The part of the Ink render instance the recovery uses. */
export interface InkHandle {
  /** Erase the current frame and forget it, so the next render starts clean. */
  clear(): void;
  /** Re-render the given element now. */
  rerender(node: unknown): void;
}

/**
 * Redraw the live frame cleanly after a resize. The absolute clear comes first, so the cursor sits
 * at the top of a blank viewport; `ink.clear()` then resets Ink's own frame memory (its relative
 * erase at the home row is a no-op), and the re-render draws the fresh frame from there. The old
 * viewport, banner included, is left in the scrollback where the terminal reflows it like any
 * history.
 */
export function recoverFrame(stdout: ResizableOutput, ink: InkHandle, node: unknown): void {
  stdout.write(clearScreenKeepingScrollback(stdout.rows ?? 24));
  ink.clear();
  ink.rerender(node);
}

/**
 * Watch `stdout` for resize and call `onSettle` once the size stops changing. Events that do not
 * change the size are ignored; a burst is coalesced with a trailing debounce. Returns a function
 * that detaches the listener and drops any pending redraw.
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
