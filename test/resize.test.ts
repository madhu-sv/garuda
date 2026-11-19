import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearScreenKeepingScrollback,
  type InkHandle,
  type ResizableOutput,
  recoverFrame,
  watchResize,
} from "../src/cli/chat/resize.js";

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

  it("recoverFrame clears absolutely, resets Ink, then redraws, in that order", () => {
    const out = new FakeStdout(80, 30);
    const order: string[] = [];
    const node = { app: true };
    const ink: InkHandle = {
      clear: () => order.push("ink.clear"),
      rerender: (n) => {
        expect(n).toBe(node);
        order.push("rerender");
      },
    };
    const originalWrite = out.write.bind(out);
    out.write = (data: string) => {
      order.push("write");
      originalWrite(data);
    };
    recoverFrame(out, ink, node);
    // The absolute clear must land before Ink forgets the old frame and draws the new one, or the
    // redraw starts from the wrong cursor.
    expect(order).toEqual(["write", "ink.clear", "rerender"]);
    // The clear pushes the whole viewport (rows high) into the scrollback and homes the cursor.
    expect(out.writes).toEqual([clearScreenKeepingScrollback(30)]);
    expect(out.writes[0]).toBe(`${"\n".repeat(30)}\u001b[H`);
  });

  it("recoverFrame falls back to 24 rows when stdout reports none", () => {
    const writes: string[] = [];
    const out: ResizableOutput = {
      columns: 80,
      write: (data) => writes.push(data),
      on: () => undefined,
      off: () => undefined,
    };
    recoverFrame(out, { clear: () => {}, rerender: () => {} }, null);
    expect(writes[0]).toBe(clearScreenKeepingScrollback(24));
  });
});
