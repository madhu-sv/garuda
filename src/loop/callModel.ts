import { errorReason, isTransientModelError } from "../model/errors.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../model/types.js";
import type { AgentEvent } from "./events.js";

/** Waits before the retries of a broken model stream (2 retries). */
export const MODEL_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000];

/**
 * One model call. A stream that breaks with a transient error (a closed connection, an overload
 * in the stream) is sent again, up to `delays.length` times. The session gets only a complete
 * response, so a retry never leaves half a message in the record.
 */
export async function callModelWithRetry(
  model: ModelClient,
  request: ModelRequest,
  signal: AbortSignal,
  emit: (event: AgentEvent) => void,
  delays: readonly number[],
): Promise<ModelResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callModel(model, request, signal, emit);
    } catch (error) {
      if (signal.aborted || attempt >= delays.length || !isTransientModelError(error)) throw error;
      const delayMs = delays[attempt] ?? 1_000;
      emit({
        type: "model_retry",
        attempt: attempt + 1,
        maxRetries: delays.length,
        delayMs,
        reason: errorReason(error),
      });
      await sleep(delayMs, signal);
    }
  }
}

export async function callModel(
  model: ModelClient,
  request: ModelRequest,
  signal: AbortSignal,
  emit: (event: AgentEvent) => void,
): Promise<ModelResponse> {
  let response: ModelResponse | undefined;
  for await (const event of model.stream(request, { signal })) {
    if (event.type === "text_delta" || event.type === "thinking_delta") emit(event);
    else response = event.response;
  }
  if (response === undefined) throw new Error("Model stream ended without a response.");
  return response;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
