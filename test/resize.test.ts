import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOME_AND_ERASE_DOWN,
  type ResizableOutput,
  repaintFresh,
  type Unmountable,
  watchResize,
} from "../src/cli/chat/resize.js";
import { ChatStore } from "../src/cli/chat/store.js";

/** A stdout double: mutable size, a captured write, and the "resize" event watchResize listens to. */
class FakeStdout extends EventEmitter implements ResizableOutput {
  columns: number;
  rows: number;
  writes: string[] = [];
  constructor(columns = 80, rows = 24) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write(data: string): void {
    this.writes.push(data);
  }
  /** Change the size and fire the event, as a terminal does. */
  resize(columns: number, rows = this.rows): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

describe("resize recovery (0.21.x)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("redraws once after a burst settles, not per event", () => {
    const out = new FakeStdout(60);
    let settles = 0;
    watchResize(out, () => settles++, 80);
    // A drag sends many events in quick succession.
    out.resize(70);
    out.resize(80);
    out.resize(90);
    vi.advanceTimersByTime(79);
    expect(settles).toBe(0); // still within the debounce window
    vi.advanceTimersByTime(1);
    expect(settles).toBe(1); // one redraw for the whole burst
  });

  it("ignores an event that did not change the size", () => {
    const out = new FakeStdout(80);
    let settles = 0;
    watchResize(out, () => settles++, 80);
    out.emit("resize"); // same 80x24: a spurious event
    vi.advanceTimersByTime(100);
    expect(settles).toBe(0);
    out.resize(100); // a real change
    vi.advanceTimersByTime(100);
    expect(settles).toBe(1);
  });

  it("detach drops the listener and any pending redraw", () => {
    const out = new FakeStdout(60);
    let settles = 0;
    const stop = watchResize(out, () => settles++, 80);
    out.resize(80);
    stop(); // before the timer fires
    vi.advanceTimersByTime(200);
    expect(settles).toBe(0);
    out.resize(100); // no longer listening
    vi.advanceTimersByTime(200);
    expect(settles).toBe(0);
  });

  it("repaintFresh unmounts, erases the viewport absolutely, then remounts, in that order", () => {
    const out = new FakeStdout(80, 30);
    const order: string[] = [];
    const ink: Unmountable = { unmount: () => order.push("unmount") };
    const originalWrite = out.write.bind(out);
    out.write = (data: string) => {
      order.push(`write:${data === HOME_AND_ERASE_DOWN ? "home-erase" : "other"}`);
      originalWrite(data);
    };
    repaintFresh(out, ink, () => order.push("remount"));
    // The old frame must stop and the viewport be erased before the fresh mount draws, or the new
    // frame lands on top of the old one.
    expect(order).toEqual(["unmount", "write:home-erase", "remount"]);
    // The erase is absolute (home + erase-down), never a row count that reflow would invalidate.
    expect(out.writes).toEqual([HOME_AND_ERASE_DOWN]);
    expect(HOME_AND_ERASE_DOWN).toBe("\u001b[H\u001b[J");
  });

  it("the store redraws the banner at the new width, and leaves later items alone", () => {
    const store = new ChatStore(
      { model: "m", sandbox: "s" },
      { paint: (_s, t) => t, keyHints: false },
    );
    store.printBanner("banner at 80");
    store.print("a finished line");
    expect(store.getState().items.map((i) => (i.kind === "output" ? i.text : i.kind))).toEqual([
      "banner at 80",
      "a finished line",
    ]);
    store.updateBanner("banner at 44");
    // Only the banner item changes; the finished line stays.
    expect(store.getState().items.map((i) => (i.kind === "output" ? i.text : i.kind))).toEqual([
      "banner at 44",
      "a finished line",
    ]);
  });

  it("updateBanner does nothing when no banner was printed", () => {
    const store = new ChatStore(
      { model: "m", sandbox: "s" },
      { paint: (_s, t) => t, keyHints: false },
    );
    store.print("just a line");
    store.updateBanner("should be ignored");
    expect(store.getState().items.map((i) => (i.kind === "output" ? i.text : i.kind))).toEqual([
      "just a line",
    ]);
  });
});
