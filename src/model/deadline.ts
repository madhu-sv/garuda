import type { ModelClient, ModelEvent, ModelRequest, StreamOptions } from "./types.js";

/**
 * A model client with a deadline (0.7: a scheduled job on the Batch API). Before `switchAt` every
 * request goes to the slow, cheap `primary` (the Batch API); a request still waiting at `switchAt`
 * is cancelled and sent again to the fast `fallback` (the normal API), and so is every later one.
 * A request that waits longer than `stepLimitMs` goes to the fallback too, but only that one: the
 * next request tries the primary again. The user's abort is never a switch.
 */
export class DeadlineClient implements ModelClient {
  readonly serverTools?: NonNullable<ModelClient["serverTools"]>;
  /** Requests answered by each client, and when the switch happened. */
  readonly calls = {
    primary: 0,
    fallback: 0,
    /** Requests that waited past the step limit and went to the fallback. */
    slow: 0,
    switchedAt: undefined as Date | undefined,
  };
  private fallbackClient: ModelClient | undefined;
  private readonly stepLimitMs: number;
  private readonly now: () => number;

  constructor(
    private readonly primary: ModelClient,
    private readonly fallback: () => Promise<ModelClient>,
    private readonly switchAt: Date,
    options: { stepLimitMs?: number; now?: () => number } = {},
  ) {
    this.stepLimitMs = options.stepLimitMs ?? Number.POSITIVE_INFINITY;
    this.now = options.now ?? Date.now;
    if (primary.serverTools !== undefined) this.serverTools = primary.serverTools;
  }

  async *stream(request: ModelRequest, options?: StreamOptions): AsyncIterable<ModelEvent> {
    const left = this.switchAt.getTime() - this.now();
    if (this.calls.switchedAt !== undefined || left <= 0) {
      yield* this.viaFallback(request, options);
      return;
    }
    const timer = new AbortController();
    const stepOnly = this.stepLimitMs < left;
    const handle = setTimeout(
      () => timer.abort(stepOnly ? new StepTooSlow() : new DeadlineReached()),
      Math.min(left, this.stepLimitMs),
    );
    const signals = [timer.signal, ...(options?.signal === undefined ? [] : [options.signal])];
    try {
      // The primary answers at the end (a batch): nothing is shown before the switch point.
      const events: ModelEvent[] = [];
      for await (const event of this.primary.stream(request, {
        signal: AbortSignal.any(signals),
      })) {
        events.push(event);
      }
      this.calls.primary++;
      yield* events;
    } catch (error) {
      if (options?.signal?.aborted === true || !timer.signal.aborted) throw error;
      if (stepOnly) {
        // Only this request: the next one tries the primary again.
        this.calls.slow++;
        this.fallbackClient ??= await this.fallback();
        this.calls.fallback++;
        yield* this.fallbackClient.stream(request, options);
      } else yield* this.viaFallback(request, options);
    } finally {
      clearTimeout(handle);
    }
  }

  private async *viaFallback(
    request: ModelRequest,
    options?: StreamOptions,
  ): AsyncIterable<ModelEvent> {
    if (this.calls.switchedAt === undefined) this.calls.switchedAt = new Date(this.now());
    this.fallbackClient ??= await this.fallback();
    this.calls.fallback++;
    yield* this.fallbackClient.stream(request, options);
  }
}

export class DeadlineReached extends Error {
  constructor() {
    super("The finish-by time is near: the request goes to the normal API.");
    this.name = "DeadlineReached";
  }
}

export class StepTooSlow extends Error {
  constructor() {
    super("The batch took longer than the step limit: this request goes to the normal API.");
    this.name = "StepTooSlow";
  }
}
